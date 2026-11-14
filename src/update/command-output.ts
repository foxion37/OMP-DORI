import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import type { Subprocess } from "bun";
import { UpdateInterrupted } from "./config.ts";
import type { CommandReceipt } from "./types.ts";

const OUTPUT_DRAIN_MS = 1_000;
type Recording = { readonly done: Promise<void>; cancel(): void };
// Node and Bun differ on BYOB and Bun-only reader methods; recording uses only this shared default-reader contract.
type OutputStream = {
  getReader(): {
    read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: unknown }>;
    cancel(): Promise<void>;
    releaseLock(): void;
  };
};
export type OutputProcess = Pick<
  Subprocess<"ignore", "pipe", "pipe">,
  "exited" | "exitCode" | "signalCode" | "kill"
> & {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
};

/** Retains a secret-sized tail so secrets split across reads never reach the private log. */
function recordStream(stream: OutputStream, path: string, secrets: readonly string[]): Recording {
  const fd = openSync(path, "wx", 0o600);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const overlap = Math.max(1, ...secrets.map((secret) => secret.length));
  let pending = "";
  let closed = false;
  const flush = (final: boolean): void => {
    let end = final ? pending.length : Math.max(0, pending.length - overlap);
    // Never split a UTF-16 surrogate pair between two writes.
    if (!final && end > 0 && /[\uD800-\uDBFF]/.test(pending.charAt(end - 1))) end--;
    let at = 0;
    let output = "";
    if (secrets.length === 0) {
      output = pending.slice(0, end);
      at = end;
    }
    while (at < end) {
      let secret: string | undefined;
      for (const value of secrets) {
        if (value.length > (secret?.length ?? 0) && pending.startsWith(value, at)) secret = value;
      }
      if (secret === undefined) {
        output += pending.charAt(at++);
      } else {
        output += "[redacted]";
        at += secret.length;
      }
    }
    if (output) writeSync(fd, output);
    pending = pending.slice(at);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (closed) return;
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        flush(false);
      }
      pending += decoder.decode();
      flush(true);
    } finally {
      try {
        close();
      } finally {
        reader.releaseLock();
      }
    }
  })();
  return {
    done,
    cancel: () => {
      if (closed) return;
      // Cancellation is not EOF: omit the unflushed tail rather than expose a partial secret.
      try {
        void reader.cancel().catch(() => {});
      } finally {
        close();
      }
    },
  };
}

/** A direct child's exit is not pipe EOF: descendants may retain either inherited output descriptor. */
export async function recordCommandOutput(
  proc: OutputProcess,
  receipt: CommandReceipt,
  secrets: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  onComplete?: () => void,
): Promise<void> {
  const recordings: Recording[] = [];
  let reason: string | undefined;
  let observing = true;
  const { promise: interrupted, resolve: wake } = Promise.withResolvers<void>();
  const stop = (message: string): void => {
    reason ??= message;
    wake();
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  };
  const abort = (): void => stop("updater aborted command");
  const deadline = setTimeout(() => stop("command deadline expired"), timeoutMs);
  let drain: NodeJS.Timeout | undefined;
  const exited = proc.exited.then((exit) => {
    if (!observing) return;
    receipt.exitCode = exit;
    if (proc.signalCode) receipt.signal = proc.signalCode;
  });
  signal?.addEventListener("abort", abort, { once: true });
  try {
    recordings.push(recordStream(proc.stdout, receipt.stdout, secrets));
    recordings.push(recordStream(proc.stderr, receipt.stderr, secrets));
    const complete = Promise.all([exited, ...recordings.map((recording) => recording.done)]);
    if (signal?.aborted) abort();
    await Promise.race([exited, interrupted, complete]);
    const { promise: expired, resolve: expire } = Promise.withResolvers<boolean>();
    drain = setTimeout(() => expire(false), OUTPUT_DRAIN_MS);
    const drained = await Promise.race([complete.then(() => true), expired]);
    const recovery = "descendants may still be running; inspect the retained receipt before recover --ack-stopped";
    if (!drained) {
      throw new UpdateInterrupted(
        `${reason ? `${reason}; ` : ""}output drain exceeded ${OUTPUT_DRAIN_MS}ms; output is incomplete; ${recovery}`,
      );
    }
    onComplete?.();
    if (reason !== undefined || receipt.signal !== undefined) {
      throw new UpdateInterrupted(`${reason ?? "direct child terminated by signal"}; ${recovery}`);
    }
  } finally {
    observing = false;
    clearTimeout(deadline);
    clearTimeout(drain);
    signal?.removeEventListener("abort", abort);
    // Observe late reader failures, but never wait for an inherited pipe or underlying cancel promise.
    void Promise.allSettled(recordings.map((recording) => recording.done));
    try {
      recordings[0]?.cancel();
    } finally {
      recordings[1]?.cancel();
    }
  }
}
