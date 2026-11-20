import { Buffer } from "node:buffer";
import type { GatewayClock } from "./discord-gateway.ts";
import { type Message, transientRetryDelay } from "./discord-inbound-api.ts";
import { MessengerError } from "./http.ts";

export type ThreadIntake = {
  cursorFor(channel: string): string | undefined;
  parentFor?(channel: string): string | undefined;
  needsThread?(message: Message): boolean;
  resolveThread?(channel: string, signal: AbortSignal): Promise<string | undefined>;
  adoptThread?(channel: string, parent: string): string;
};

type Candidate = { message: Message; bytes: number; after: string | undefined };
const FRAME_LIMIT = 100;
const BYTE_LIMIT = 1024 * 1024;

/** Volatile, pre-scope candidates only: one resolver, no disk spool and no promise retained per dispatch. */
export const discordThreadAdmission = (
  intake: ThreadIntake,
  clock: GatewayClock,
  admit: (message: Message, after: string | undefined, parent: string) => void,
  report: (line: string) => void,
  fail: (error: unknown) => void,
) => {
  const controller = new AbortController();
  const { signal } = controller;
  const cancelled = new Error("Discord inbound closed before thread scope admission");
  const candidates: Candidate[] = [];
  let bytes = 0;
  let active = false;
  let running = Promise.resolve();
  const classified = new Error("Discord inbound thread scope established by listing");
  let lookup: { channel: string; controller: AbortController } | undefined;
  const pause = (ms: number, stop: AbortSignal): Promise<void> => {
    stop.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const abort = () => {
      clock.clearTimeout(timer);
      reject(stop.reason);
    };
    const timer = clock.setTimeout(() => {
      stop.removeEventListener("abort", abort);
      resolve();
    }, ms);
    stop.addEventListener("abort", abort, { once: true });
    return promise;
  };
  const resolve = async (channel: string, stop: AbortSignal): Promise<string | undefined> => {
    for (let delay = 2_000; ; delay = Math.min(delay * 2, 30_000)) {
      try {
        return await intake.resolveThread!(channel, stop);
      } catch (error) {
        const wait = transientRetryDelay(error, delay);
        if (stop.aborted || wait === undefined) throw error;
        report(`DISCORD_GATEWAY_ACCEPT_RETRY discord retry_in=${wait / 1000}s`);
        await pause(wait, stop);
      }
    }
  };
  const finish = (channel: string, parent?: string): void => {
    if (!candidates.some((candidate) => candidate.message.channel_id === channel)) return;
    signal.throwIfAborted();
    const floor = parent === undefined ? undefined : intake.adoptThread!(channel, parent);
    for (let index = 0; index < candidates.length;) {
      const candidate = candidates[index]!;
      if (candidate.message.channel_id !== channel) {
        index++;
        continue;
      }
      if (parent !== undefined) {
        admit(candidate.message, candidate.after ?? floor, parent);
        signal.throwIfAborted();
      }
      candidates.splice(index, 1);
      bytes -= candidate.bytes;
    }
  };
  const drain = () => {
    if (active || signal.aborted) return;
    active = true;
    running = (async () => {
      while (candidates.length && !signal.aborted) {
        // Only the accounted array retains raw payloads across a metadata await.
        const channel = candidates[0]!.message.channel_id;
        const attempt = new AbortController();
        const abort = () => attempt.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        lookup = { channel, controller: attempt };
        try {
          let parent: string | undefined;
          try {
            parent = await resolve(channel, attempt.signal);
          } catch (error) {
            if (error !== classified || attempt.signal.reason !== classified) throw error;
            parent = intake.parentFor?.(channel);
          }
          signal.throwIfAborted();
          finish(channel, parent);
        } finally {
          signal.removeEventListener("abort", abort);
          lookup = undefined;
        }
      }
    })()
      .catch((error: unknown) => {
        if (error !== cancelled || !signal.aborted) fail(error);
      })
      .finally(() => {
        active = false;
        if (candidates.length && !signal.aborted) drain();
      });
  };
  return {
    flushKnown(): void {
      if (signal.aborted) return;
      for (let index = 0; index < candidates.length;) {
        const channel = candidates[index]!.message.channel_id;
        const parent = intake.parentFor?.(channel);
        if (parent === undefined) {
          index++;
          continue;
        }
        // Listing scope must promote originals before REST can checkpoint/deduplicate their copies.
        finish(channel, parent);
        if (lookup?.channel === channel) lookup.controller.abort(classified);
      }
    },
    push(message: Message): void {
      if (signal.aborted || !intake.needsThread?.(message)) return;
      if (!intake.resolveThread || !intake.adoptThread)
        throw new MessengerError("Discord inbound thread resolver is unavailable", 0);
      const size = Buffer.byteLength(JSON.stringify(message), "utf8");
      if (candidates.length === FRAME_LIMIT || size > BYTE_LIMIT - bytes) {
        throw new MessengerError(
          `Discord inbound thread staging limit exceeded: limits=${FRAME_LIMIT} frames/${BYTE_LIMIT} bytes ` +
            `pending=${candidates.length + 1} frames/${bytes + size} bytes; unresolved payloads are volatile`,
          0,
        );
      }
      candidates.push({ message, bytes: size, after: intake.cursorFor(message.channel_id) });
      bytes += size;
      drain();
    },
    close(): void {
      controller.abort(cancelled);
      candidates.length = 0;
      bytes = 0;
    },
    done: (): Promise<void> => running,
  };
};
