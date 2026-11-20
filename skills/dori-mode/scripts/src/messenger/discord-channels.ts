/**
 * The operator's purpose notes for Discord channels and threads, and the context record `dori inbound discord
 * --context` puts beside each owner message. A purpose is the operator's local note; a topic is channel metadata that
 * anyone with Manage Channels can change. Neither is an owner instruction.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../checkpoint-lock.ts";
import type { DcChannel, Discord } from "./discord.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";
import { MessengerError } from "./http.ts";

export class ChannelPurposeError extends Error {}

export type ChannelPurpose = { readonly purpose: string; readonly name?: string; readonly updatedAt: string };
type Purposes = Readonly<Record<string, ChannelPurpose>>;

const MAX_PURPOSE = 500;
const LOCK_WAIT_MS = 5_000;
// C0 and C1 controls, DEL, the Unicode line and paragraph separators and bidirectional overrides and isolates: a
// purpose is one line of text that reads as it is stored.
// oxlint-disable-next-line no-control-regex -- the pattern deliberately matches control characters to reject them
const NOT_ONE_LINE = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** A purpose is one line of 1 to 500 characters after trimming; anything else is refused before it is stored. */
export const purposeText = (purpose: string): string => {
  const text = purpose.trim();
  if (!oneLine(text)) throw new ChannelPurposeError(`--purpose must be one line of 1 to ${MAX_PURPOSE} characters`);
  return text;
};

/** The stored form `purposeText` writes: trimmed, 1 to 500 characters, one line. */
const oneLine = (text: string): boolean =>
  text !== "" && text === text.trim() && text.length <= MAX_PURPOSE && !NOT_ONE_LINE.test(text);

/** A stored entry is read only in the form `set` writes, so a hand-edited bad purpose counts as damage. */
const isPurpose = (value: unknown): value is ChannelPurpose => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { purpose, name, updatedAt } = value as Record<string, unknown>;
  return (
    typeof purpose === "string" &&
    oneLine(purpose) &&
    typeof updatedAt === "string" &&
    (name === undefined || typeof name === "string")
  );
};

/** `<stateDir>/discord-channels.json`: channel or thread ID to its purpose, written whole under a writer lock. */
export class DiscordChannels {
  readonly path: string;
  constructor(readonly stateDir: string) {
    this.path = join(stateDir, "discord-channels.json");
  }

  /** Every recorded purpose; a missing file is none, a damaged one is an error rather than an empty record. */
  read(): Purposes {
    if (!existsSync(this.path)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new ChannelPurposeError(`${this.path} is not valid JSON; repair or remove it`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new ChannelPurposeError(`${this.path} must hold one JSON object`);
    for (const [id, entry] of Object.entries(parsed))
      if (!isDiscordSnowflake(id) || !isPurpose(entry))
        throw new ChannelPurposeError(`${this.path}: entry ${JSON.stringify(id)} is not a channel purpose`);
    return parsed as Purposes;
  }

  /** Records or replaces one purpose (see `purposeText`). */
  async set(id: string, purpose: string, name: string | undefined, now: number): Promise<ChannelPurpose> {
    // Only what read() accepts is written, so one bad entry can never make the whole file unreadable.
    if (!isDiscordSnowflake(id)) throw new ChannelPurposeError(`${JSON.stringify(id)} is not a Discord ID`);
    const entry: ChannelPurpose = {
      purpose: purposeText(purpose),
      ...(name === undefined ? {} : { name }),
      updatedAt: new Date(now).toISOString(),
    };
    await this.change((all) => ({ ...all, [id]: entry }));
    return entry;
  }

  /** Removes one purpose; false when none was recorded. */
  async clear(id: string): Promise<boolean> {
    let had = false;
    await this.change((all) => {
      had = Object.hasOwn(all, id);
      return Object.fromEntries(Object.entries(all).filter(([key]) => key !== id));
    });
    return had;
  }

  private async change(update: (all: Purposes) => Purposes): Promise<void> {
    mkdirSync(this.stateDir, { recursive: true });
    const fail = (m: string) => new ChannelPurposeError(`channel purpose lock ${m}`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const held = takeLock(`${this.path}.lock`, Date.now(), fail);
      if (typeof held !== "string") {
        try {
          const tmp = `${this.path}.${process.pid}.tmp`;
          writeFileSync(tmp, `${JSON.stringify(update(this.read()), null, 2)}\n`, { mode: 0o600 });
          chmodSync(tmp, 0o600);
          renameSync(tmp, this.path);
          return;
        } finally {
          held();
        }
      }
      if (Date.now() >= deadline) throw new ChannelPurposeError(`channel purposes are locked (${held})`);
      await Bun.sleep(50);
    }
  }
}

export type InboundContext = {
  readonly channel: {
    readonly id: string;
    readonly name?: string;
    readonly topic?: string;
    readonly dm?: true;
    readonly purpose: string | null;
  };
  readonly thread: { readonly id: string; readonly name?: string; readonly purpose: string | null } | null;
  readonly error?: string;
};

const THREAD_TYPES = new Set([10, 11, 12]);
const DM_TYPES = new Set([1, 3]);
const CACHE_MS = 60_000;
/** Most lookups held at once; a burst across more channels than this in one minute evicts the oldest. */
const CACHE_MAX = 500;
const TIMED_OUT = Symbol("timed out");

/**
 * Resolves where a message was posted, never throwing: a thread is named under its parent channel, each with its own
 * recorded purpose, and a DM is marked as one. Channel lookups are cached for a minute and bounded by `timeoutMs`. A
 * failed or late lookup or an unreadable purpose file still returns a record, with what is known and an `error` that
 * names the failure without echoing a response body.
 */
export const inboundContext = (discord: Discord, channels: DiscordChannels, now: () => number, timeoutMs = 5_000) => {
  // One lookup per channel per minute, shared while in flight: a failure or a hang is remembered too, so a burst of
  // owner messages in a broken channel makes one request, not one per message.
  type Entry = { readonly at: number; readonly value: Promise<DcChannel>; settled: boolean };
  const cache = new Map<string, Entry>();
  const lookup = (id: string): { readonly value: Promise<DcChannel>; readonly stuck: boolean } => {
    const hit = cache.get(id);
    if (hit && now() - hit.at < CACHE_MS)
      return { value: hit.value, stuck: !hit.settled && now() - hit.at >= timeoutMs };
    // A long-running intake meets many channels and threads once: drop every expired entry, and past the cap the
    // oldest, so the cache holds at most the channels of the last minute, never more than CACHE_MAX.
    for (const [key, old] of cache) if (now() - old.at >= CACHE_MS) cache.delete(key);
    cache.delete(id);
    for (const key of cache.keys()) {
      if (cache.size < CACHE_MAX) break;
      cache.delete(key);
    }
    const entry: Entry = { at: now(), value: discord.channel(id), settled: false };
    const settle = () => {
      entry.settled = true;
    };
    entry.value.then(settle, settle);
    cache.set(id, entry);
    return { value: entry.value, stuck: false };
  };
  const where = async (channelId: string): Promise<InboundContext> => {
    const errors: string[] = [];
    let purposes: Purposes = {};
    try {
      purposes = channels.read();
    } catch {
      errors.push("channel purposes unreadable");
    }
    const purpose = (id: string): string | null => purposes[id]?.purpose ?? null;
    /** The channel as looked up, or its ID and purpose alone when the lookup fails. */
    const described = async (id: string): Promise<DcChannel | undefined> => {
      // Retries and a hung connection must not hold the owner's message: past the bound it goes out without them.
      const pending = lookup(id);
      if (pending.stuck) {
        errors.push("channel lookup timed out");
        return undefined;
      }
      const late = Promise.withResolvers<typeof TIMED_OUT>();
      const timer = setTimeout(() => late.resolve(TIMED_OUT), timeoutMs);
      try {
        const found = await Promise.race([pending.value, late.promise]);
        if (found !== TIMED_OUT) return found;
        errors.push("channel lookup timed out");
      } catch (e) {
        errors.push(`channel lookup failed${e instanceof MessengerError && e.status > 0 ? ` (HTTP ${e.status})` : ""}`);
      } finally {
        clearTimeout(timer);
      }
      return undefined;
    };
    const channel = (id: string, c: DcChannel | undefined): InboundContext["channel"] => ({
      id,
      ...(typeof c?.name === "string" ? { name: c.name } : {}),
      ...(typeof c?.topic === "string" && c.topic !== "" ? { topic: c.topic } : {}),
      purpose: purpose(id),
    });
    const here = await described(channelId);
    let record: Omit<InboundContext, "error">;
    if (here && DM_TYPES.has(here.type))
      record = { channel: { id: channelId, dm: true, purpose: purpose(channelId) }, thread: null };
    else if (here && THREAD_TYPES.has(here.type) && typeof here.parent_id === "string") {
      const thread = {
        id: channelId,
        ...(typeof here.name === "string" ? { name: here.name } : {}),
        purpose: purpose(channelId),
      };
      record = { channel: channel(here.parent_id, await described(here.parent_id)), thread };
    } else record = { channel: channel(channelId, here), thread: null };
    return errors.length ? { ...record, error: errors.join("; ") } : record;
  };
  /** `cached()`: how many lookups are held, so the eviction can be checked. */
  return Object.assign(where, { cached: (): number => cache.size });
};
