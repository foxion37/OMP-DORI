import { DeliveryUncertainError, type HttpRequest, type HttpResponse, MessengerError } from "./http.ts";

export const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

const discordErrorCode = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body) as { code?: unknown } | null;
    return typeof parsed?.code === "number" ? String(parsed.code) : undefined;
  } catch {
    return undefined;
  }
};

export function discordResponse<T>(res: HttpResponse, method: HttpRequest["method"], operation: string): T {
  if (res.status >= 300)
    throw new MessengerError(
      `${operation}: ${res.status} ${res.body.slice(0, 160)}`,
      res.status,
      discordErrorCode(res.body),
    );
  if (method !== "GET" && res.status !== 204 && !res.body) throw new DeliveryUncertainError(operation, res.status);
  try {
    return (res.body ? JSON.parse(res.body) : {}) as T;
  } catch (error) {
    if (method !== "GET") throw new DeliveryUncertainError(operation, res.status);
    throw error;
  }
}

export const responseId = (body: unknown, operation: string): string => {
  if (body === null || typeof body !== "object" || !("id" in body) || typeof body.id !== "string" || !body.id)
    throw new DeliveryUncertainError(`${operation}: missing remote ID`, 200);
  return body.id;
};

export type PostedMessage = {
  readonly id?: unknown;
  readonly type?: number;
  readonly message_reference?: { readonly message_id?: string; readonly channel_id?: string };
};

export const confirmedReply = (sent: PostedMessage | null, channel: string, replyTo: string): boolean => {
  const ref = sent?.message_reference;
  return (
    sent?.type === 19 && ref?.message_id === replyTo && (ref.channel_id === undefined || ref.channel_id === channel)
  );
};

export const incompleteReplyReceipt = (
  ids: readonly string[],
  stopped?: { readonly status: number; readonly detail: string },
): MessengerError => {
  const known = ids.length ? ` (already posted: ${ids.join(" ")})` : "";
  const failure = stopped ? `; ${stopped.detail}; do not resend. Inspect the original remote target.` : "";
  return new MessengerError(
    `discord send: incomplete delivery receipt; outcome uncertain${known}${failure}`,
    stopped?.status ?? 200,
    "DELIVERY_UNCERTAIN",
    "uncertain",
  );
};
