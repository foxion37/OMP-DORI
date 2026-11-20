import type { Clock } from "../run.ts";

export type HttpRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  /** Explicit read-only RPCs may use POST; unknown operations remain mutations. */
  readonly readOnly?: boolean;
  /** Safe operation label, never a credential-bearing URL. */
  readonly operation?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData | Uint8Array<ArrayBuffer>;
  readonly signal?: AbortSignal;
};
export type HttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    ...(req.headers === undefined ? {} : { headers: req.headers }),
    ...(req.body === undefined ? {} : { body: req.body }),
    ...(req.signal === undefined ? {} : { signal: req.signal }),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

export class MessengerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly outcome: "rejected" | "uncertain" | "confirmed" = "rejected",
    readonly receipt?: { readonly channel: string; readonly messageId: string },
  ) {
    super(message);
  }
}

export class DeliveryUncertainError extends MessengerError {
  constructor(operation: string, status = 0) {
    super(
      `${operation}: delivery uncertain${status ? ` (HTTP ${status})` : ""}; the request may have succeeded; do not resend. Inspect the original remote target and reconcile its IDs before retrying.`,
      status,
      "DELIVERY_UNCERTAIN",
      "uncertain",
    );
  }
}

/** Explicit server delay retained when this HTTP call cannot perform the retry itself. */
export class RateLimitError extends MessengerError {
  constructor(
    operation: string,
    readonly retryAfterMs: number,
    readonly waitLimitMs: number,
  ) {
    const overBudget = retryAfterMs > waitLimitMs;
    super(
      overBudget
        ? `${operation}: HTTP 429; Retry-After exceeds the ${waitLimitMs / 1000}s automatic retry limit`
        : `${operation}: HTTP 429; retry after ${retryAfterMs / 1000}s`,
      429,
      overBudget ? "RATE_LIMIT_WAIT_EXCEEDED" : undefined,
    );
  }
}

/** A new inbound poll waits at least as long as the server asked, or stops if that wait exceeds the budget. */
export const inboundPollRetryDelay = (error: unknown, intervalMs: number): number => {
  if (!(error instanceof RateLimitError)) return intervalMs;
  if (error.retryAfterMs > error.waitLimitMs) throw error;
  return Math.max(intervalMs, error.retryAfterMs);
};

export class UnsafeMessageError extends Error {}

export const guardText = (text: string): string => {
  if (text.includes("$("))
    throw new UnsafeMessageError("message text contains $( ; build messages as data, never through a shell string");
  return text;
};

export type RetryPolicy = { readonly attempts: number; readonly baseMs: number; readonly maxMs: number };
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1_000, maxMs: 60_000 };

const requestedWaitMs = (
  header: string | undefined,
  bodySeconds: number | undefined,
  now?: number,
): number | undefined => {
  const seconds = Number(header);
  if (seconds > 0 && (Number.isFinite(seconds) || (now !== undefined && /^\d+(?:\.\d+)?$/.test(header ?? "")))) {
    return Math.ceil(seconds * 1000);
  }
  if (now !== undefined && header && Number.isNaN(seconds)) {
    const date = Date.parse(header);
    if (date > now) return date - now;
  }
  return bodySeconds !== undefined && Number.isFinite(bodySeconds) && bodySeconds > 0
    ? Math.ceil(bodySeconds * 1000)
    : undefined;
};

export const withBackoff = async (
  http: Http,
  clock: Clock,
  req: HttpRequest,
  policy: RetryPolicy = DEFAULT_RETRY,
  retryAfterFromBody?: (body: string) => number | undefined,
): Promise<HttpResponse> => {
  const mutation = req.method !== "GET" && req.readOnly !== true;
  const operation = req.operation ?? `messenger ${req.method}`;
  let last: HttpResponse | undefined;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    req.signal?.throwIfAborted();
    try {
      last = await http(req);
    } catch (error) {
      if (!mutation) throw error;
      req.signal?.throwIfAborted();
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      const safeCode =
        typeof code === "string" && ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"].includes(code)
          ? ` (${code})`
          : "";
      throw new DeliveryUncertainError(`${operation}${safeCode}`);
    }
    req.signal?.throwIfAborted();
    if (mutation && (last.status === 408 || last.status >= 500))
      throw new DeliveryUncertainError(operation, last.status);
    // Platform 429 responses reject the request; 5xx on reads can be retried safely.
    if (last.status !== 429 && last.status < 500) return last;
    const rateLimited = last.status === 429;
    const explicitMs = requestedWaitMs(
      last.headers["retry-after"]?.trim(),
      retryAfterFromBody?.(last.body),
      rateLimited ? clock.now() : undefined,
    );
    const hasAttempt = attempt < policy.attempts - 1;
    if (rateLimited && explicitMs !== undefined && (explicitMs > policy.maxMs || !hasAttempt)) {
      throw new RateLimitError(operation, explicitMs, policy.maxMs);
    }
    if (hasAttempt) {
      const ms = Math.min(policy.maxMs, explicitMs ?? policy.baseMs * 2 ** attempt);
      if (!req.signal) await clock.sleep(ms);
      else {
        const signal = req.signal;
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          await promise;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      }
    }
  }
  return last as HttpResponse;
};
