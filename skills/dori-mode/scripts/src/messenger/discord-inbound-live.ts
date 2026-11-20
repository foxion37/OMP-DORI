import { discordGateway, type GatewayClock, type GatewaySocket } from "./discord-gateway.ts";
import { type Emit, type Message, transientRetryDelay } from "./discord-inbound-api.ts";
import type { DiscordInboundQueue } from "./discord-inbound-queue.ts";
import { discordThreadAdmission, type ThreadIntake } from "./discord-inbound-thread-admission.ts";

const GUILD_MESSAGES = 1 << 9;
const DIRECT_MESSAGES = 1 << 12;
const MESSAGE_CONTENT = 1 << 15;

type Intake = ThreadIntake & {
  accepts(message: Message, parent?: string | null): boolean;
  sync(emit: Emit, queue?: DiscordInboundQueue, scoped?: () => void): Promise<void>;
  accept(message: Message, emit: Emit, after?: string | null, parent?: string | null): void | Promise<void>;
};

export type DiscordInboundLive = { done: Promise<void>; close(): void };
export type DiscordInboundLifecycle = { ready(): void; disconnect(): void };

/**
 * Scoped dispatches and backfills share the durable FIFO. Unknown thread scope is resolved in bounded RAM
 * before payload admission; those candidates do not have the admitted queue's crash/deletion recovery guarantee.
 */
export const discordInboundLive = (
  intake: Intake,
  open: (url: string) => GatewaySocket,
  token: string,
  clock: GatewayClock,
  emit: Emit,
  report: (line: string) => void,
  queue: DiscordInboundQueue,
  lifecycle?: DiscordInboundLifecycle,
): DiscordInboundLive => {
  const admission = new AbortController();
  const cancelled = new Error("Discord inbound closed before ledger admission");
  const deliver: Emit = (message) => emit(message, admission.signal);
  let running = Promise.resolve();
  let recover = queue.first()?.kind === "message";
  let draining = false;
  let failure: unknown;
  let dead = false;
  let timer: unknown;
  let wake: (() => void) | undefined;
  const pause = (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    wake = resolve;
    timer = clock.setTimeout(resolve, ms);
    return promise;
  };
  const backfill = async () => {
    for (let delay = 2_000; ; delay = Math.min(delay * 2, 30_000)) {
      try {
        return await intake.sync(deliver, queue, metadata.flushKnown);
      } catch (error) {
        const wait = transientRetryDelay(error, delay);
        if (dead || wait === undefined) throw error;
        report(`DISCORD_GATEWAY_BACKFILL_RETRY discord retry_in=${wait / 1000}s`);
        await pause(wait);
        if (dead) return;
      }
    }
  };
  const fail = (error: unknown) => {
    failure = error;
    dead = true; // Preserve every committed record and its admission position.
    close();
  };
  const drain = () => {
    if (draining || dead) return;
    draining = true;
    running = (async () => {
      try {
        if (recover) {
          recover = false;
          await backfill();
        }
        for (let job = queue.first(); job && !dead; job = queue.first()) {
          if (job.kind === "sync") {
            await backfill();
            if (!dead) queue.remove(job.id);
          } else {
            job = queue.before(job.id) ?? job;
            const message = JSON.parse(job.payload) as Message;
            await intake.accept(message, deliver, job.admittedAfter, job.parent);
            if (!dead) {
              if (intake.accepts(message, job.parent)) queue.acknowledge(message.channel_id, message.id);
              else queue.remove(job.id);
            }
          }
        }
      } catch (error) {
        if (error !== cancelled || !admission.signal.aborted) fail(error);
      } finally {
        draining = false;
      }
    })();
  };
  const enqueue = (kind: "sync" | "message", data?: Message, after?: string, parent?: string) => {
    if (dead) return;
    if (kind === "message" && data) {
      after ??= intake.cursorFor(data.channel_id);
      parent ??= intake.parentFor?.(data.channel_id);
    }
    queue.push(kind, data, after, parent);
    drain(); // Persist first; each caller owns propagation of a storage failure.
  };
  const metadata = discordThreadAdmission(
    intake,
    clock,
    (message, after, parent) => enqueue("message", message, after, parent),
    report,
    fail,
  );
  const gateway = discordGateway(open, token, clock, report, {
    label: "DISCORD_GATEWAY",
    intents: GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT,
    online: false,
    onDisconnect: () => lifecycle?.disconnect(),
    onReady: () => {
      try {
        lifecycle?.ready();
        enqueue("sync");
      } catch (error) {
        fail(error);
      }
    },
    onDispatch: (type, data) => {
      if (dead || type !== "MESSAGE_CREATE") return;
      try {
        const message = data as Message;
        if (intake.accepts(message)) enqueue("message", message);
        else metadata.push(message);
      } catch (error) {
        fail(error);
      }
    },
  });
  const close = () => {
    admission.abort(cancelled);
    dead = true;
    metadata.close();
    if (timer !== undefined) clock.clearTimeout(timer);
    wake?.();
    gateway.close();
  };
  const done = gateway.done.finally(async () => {
    close();
    await metadata.done();
    await running;
    if (failure !== undefined) throw failure;
  });
  drain();
  return { done, close };
};
