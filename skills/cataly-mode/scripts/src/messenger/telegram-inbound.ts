import { InboundActivityError } from "../../../../../src/update/source-activity.ts";
import { inboundPollRetryDelay, MessengerError } from "./http.ts";
import { TelegramCursorError } from "./telegram-cursor-error.ts";
import type { TgInboundStore } from "./telegram-inbound-state.ts";
import type { Telegram } from "./telegram.ts";
import { mediaOf, replyOf, telegramUpdateReceipt, threadOf, type TgUpdate } from "./telegram-inbound-update.ts";

/** `message` for a new message, `edit` when the owner edited an earlier one. */
export type TgInboundKind = "message" | "edit";

/** Transient poll errors retry within this cap instead of sleeping the whole --loop interval. */
export const ERROR_BACKOFF_CAP_MS = 15_000;

export type TgMedia = { readonly kind: string; readonly fileId: string; readonly messageId?: number };

export type TgInbound = {
  readonly kind: TgInboundKind;
  readonly source: "dm" | "topic";
  readonly chat: number;
  readonly thread?: number;
  readonly updateId: number;
  /** The Telegram message_id — the id a later edit replaces (edit lines print it as mid=). */
  readonly messageId?: number;
  /** The message_id this one replies to; absent when it replies to nothing or only sits in a topic. */
  readonly replyTo?: number;
  readonly from: number;
  readonly username?: string;
  readonly text?: string;
  /** Telegram's message date in unix seconds: what receive-lag is measured against. */
  readonly date?: number;
  readonly media?: TgMedia;
};

/**
 * Owner-gated Telegram inbound: DMs from the configured owner and, when a group topic is
 * configured, that owner's messages in that topic only. Everything else is dropped.
 */
export type TgInboundOptions = {
  readonly ownerId: number;
  readonly groupChatId?: number;
  readonly topicId?: number;
};

/**
 * Env ints accept only /^-?\d+$/ after trimming; empty, whitespace-only, `1e3` and
 * `0x10` are refused at start with an error that names the variable.
 */
export const envInt = (name: string, raw: string | undefined): number => {
  if (raw === undefined) throw new Error(`${name} is not set`);
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`${name} must be an integer, got: ${JSON.stringify(raw)}`);
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer, got: ${JSON.stringify(raw)}`);
  return n;
};

/**
 * The inbound watch loop. Without `--loop` (loopMin <= 0) it is one-shot: a single
 * bounded poll, then it returns — scripts rely on that. With `--loop`, it re-polls
 * immediately after any poll that returned updates — kept or gate-dropped alike, since
 * more may be waiting behind that batch — and only sleeps after a truly empty poll
 * (the 25s long-poll already returns on arrival, so bursts deliver without waiting
 * out the interval).
 */
export const telegramInboundLoop = async (
  tg: Telegram,
  openStore: () => Promise<TgInboundStore>,
  opts: TgInboundOptions,
  loopMin: number,
  emit: (inbound: TgInbound) => void = () => {},
  warn: (message: string) => void = () => {},
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  observe?: (available: boolean) => void,
): Promise<void> => {
  let store: TgInboundStore | undefined;
  for (;;) {
    let wait = loopMin * 60_000;
    let updates: number | undefined;
    try {
      store ??= await openStore();
      ({ updates } = await pollTelegramInbound(tg, store, opts, emit));
    } catch (error) {
      if (error instanceof InboundActivityError || error instanceof TelegramCursorError) throw error;
      observe?.(false);
      // A transient poll failure must not silence intake for the whole --loop interval:
      // cap the error backoff (rate limits keep their own retry_after via inboundPollRetryDelay).
      wait = inboundPollRetryDelay(error, Math.min(wait, ERROR_BACKOFF_CAP_MS));
      const message = error instanceof Error ? error.message : String(error);
      warn(
        error instanceof MessengerError && error.status === 409
          ? `${message} (another getUpdates consumer is polling this bot token; stop it or use a separate token)`
          : message,
      );
    }
    if (updates !== undefined) observe?.(updates < 100);
    if (loopMin > 0 && updates) continue;
    if (loopMin <= 0) return; // one-shot: one bounded drain
    await sleep(wait);
  }
};

function cursorOperation<T>(run: () => T): T {
  try {
    return run();
  } catch (cause) {
    if (cause instanceof TelegramCursorError) throw cause;
    throw new TelegramCursorError("Telegram inbound cursor could not be read or saved; intake stopped", { cause });
  }
}

/**
 * Poll `getUpdates` once (new messages and edits) and hand every kept update to `emit`
 * as it is processed.
 *
 * Delivery is at-least-once: the stored offset advances past an update only after `emit`
 * returned for it (a throwing `emit` aborts the batch with the offset left before the
 * update, so the next poll returns it again — duplicates carry the same `updateId`).
 * Updates that are dropped by the gates advance the offset immediately: there is nothing
 * to deliver for them, and `getUpdates` cannot replay an update a bot has consumed.
 */
export const pollTelegramInbound = async (
  tg: Telegram,
  store: TgInboundStore,
  opts: TgInboundOptions,
  emit: (inbound: TgInbound) => void = () => {},
  now: () => number = Date.now,
): Promise<{ inbound: readonly TgInbound[]; updates: number }> => {
  const previous = cursorOperation(() => store.load());
  const observed = previous?.observedAt;
  const age = observed === undefined ? undefined : now() - observed;
  const fresh = age !== undefined && age >= 0 && age < 86_400_000;
  const updates = await tg.call<readonly TgUpdate[]>("getUpdates", {
    ...(fresh && previous !== undefined ? { offset: previous.offset } : {}),
    limit: 100,
    timeout: 25,
    allowed_updates: ["message", "edited_message"],
  });
  if (
    !Array.isArray(updates) ||
    updates.length > 100 ||
    updates.some(
      (update) =>
        !update ||
        !Number.isSafeInteger(update.update_id) ||
        update.update_id < 0 ||
        update.update_id >= Number.MAX_SAFE_INTEGER,
    )
  )
    throw new MessengerError("Telegram getUpdates returned invalid update IDs or batch size", 0);
  if (updates.length === 0) {
    if (previous?.seen.length) cursorOperation(() => store.save({ ...previous, seen: [] }));
    return { inbound: [], updates: 0 };
  }
  const observedAt = now();
  const keys = updates.map(telegramUpdateReceipt);
  // getUpdates returns the oldest unconfirmed batch (at most 100). A receipt
  // absent from this batch is acknowledged/expired, not waiting behind it.
  // Preserve all matching receipts before any emit, including later batch items.
  const seen = new Set(previous?.seen.filter((key) => keys.includes(key)));
  const out: TgInbound[] = [];
  for (const [index, u] of updates.entries()) {
    const key = keys[index];
    const kind: TgInboundKind = u.edited_message === undefined ? "message" : "edit";
    const m = u.message ?? u.edited_message;
    let keep = false;
    if (m?.from && !m.from.is_bot && m.from.id === opts.ownerId) {
      if (m.chat?.type === "private" && Number(m.chat.id) === opts.ownerId) keep = true;
      else if (
        (m.chat?.type === "group" || m.chat?.type === "supergroup") &&
        opts.groupChatId !== undefined &&
        Number(m.chat.id) === opts.groupChatId
      ) {
        // De-conflict: in a forum group the Cataly only ever listens to its own topic.
        // General counts as topic 1 — including replies there, whose reply-root id in
        // message_thread_id is not a topic id.
        const topic = threadOf(m) ?? 1;
        keep = opts.topicId === undefined || topic === opts.topicId;
      }
    }
    if (!keep || (key !== undefined && seen.has(key))) {
      cursorOperation(() => store.save({ offset: u.update_id + 1, observedAt, seen: [...seen] }));
      continue;
    }
    // A live location arrives as a stream of edited_message updates carrying no new
    // text; emitting one line per refresh would flood the consumer. Drop them.
    if (kind === "edit" && m!.location !== undefined && m!.text === undefined && m!.caption === undefined) {
      cursorOperation(() => store.save({ offset: u.update_id + 1, observedAt, seen: [...seen] }));
      continue;
    }
    const source = m!.chat!.type === "private" ? "dm" : "topic";
    const thread = source === "topic" ? (threadOf(m!) ?? 1) : threadOf(m!);
    const replyTo = replyOf(m!);
    const media = mediaOf(m!);
    const inbound: TgInbound = {
      kind,
      source,
      ...(m!.message_id === undefined ? {} : { messageId: m!.message_id }),
      ...(replyTo === undefined ? {} : { replyTo }),
      chat: Number(m!.chat!.id),
      ...(thread === undefined ? {} : { thread }),
      updateId: u.update_id,
      from: m!.from!.id,
      ...(m!.from!.username === undefined ? {} : { username: m!.from!.username }),
      ...(m!.text === undefined && m!.caption === undefined ? {} : { text: m!.text ?? m!.caption }),
      ...(m!.date === undefined ? {} : { date: m!.date }),
      ...(media === undefined ? {} : { media }),
    };
    emit(inbound); // may throw: offset stays before this update, so it is polled again
    out.push(inbound);
    if (key !== undefined) seen.add(key);
    cursorOperation(() => store.save({ offset: u.update_id + 1, observedAt, seen: [...seen] }));
  }
  return { inbound: out, updates: updates.length };
};
