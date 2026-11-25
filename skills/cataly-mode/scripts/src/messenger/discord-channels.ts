/** Private purpose notes and their source-bound receipts. A purpose is metadata, never an owner instruction. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../checkpoint-lock.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";

export class ChannelPurposeError extends Error {}

export type ChannelPurpose = { readonly purpose: string; readonly name?: string; readonly updatedAt: string };
type Purposes = Readonly<Record<string, ChannelPurpose>>;

export type PurposeSource = {
  readonly botId: string;
  readonly ownerId: string;
  readonly channelId: string;
  readonly messageId: string;
};

type PurposeReceipt = {
  readonly source: PurposeSource;
  readonly channel: string;
  readonly purpose: string | null;
  readonly result: ChannelPurpose | boolean;
};

type PurposeState = {
  readonly version: 1;
  readonly notes: Purposes;
  readonly receipts: Readonly<Record<string, PurposeReceipt>>;
};

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

const isSource = (value: unknown): value is PurposeSource => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 4)
    return false;
  const { botId, ownerId, channelId, messageId } = value as Record<string, unknown>;
  return [botId, ownerId, channelId, messageId].every(isDiscordSnowflake) && botId !== ownerId;
};

const receiptKey = (source: PurposeSource, channel: string): string =>
  JSON.stringify([source.botId, source.ownerId, source.channelId, source.messageId, channel]);

const isReceipt = (value: unknown): value is PurposeReceipt => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 4)
    return false;
  const { source, channel, purpose, result } = value as Record<string, unknown>;
  if (!isSource(source) || !isDiscordSnowflake(channel)) return false;
  return purpose === null
    ? typeof result === "boolean"
    : typeof purpose === "string" && oneLine(purpose) && isPurpose(result) && result.purpose === purpose;
};

/** Writes atomically preserve notes and receipts in the same private file. */
export class DiscordChannels {
  readonly path: string;
  constructor(readonly stateDir: string) {
    this.path = join(stateDir, "discord-channels.json");
  }

  /** Existing readers see only notes, never the internal source receipts. */
  read(): Purposes {
    return this.readState().notes;
  }

  private readState(): PurposeState {
    if (!existsSync(this.path)) return { version: 1, notes: {}, receipts: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new ChannelPurposeError(`${this.path} is not valid JSON; repair it before retrying`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new ChannelPurposeError(`${this.path} must hold one JSON object`);
    const record = parsed as Record<string, unknown>;
    const { version, notes: savedNotes, receipts: savedReceipts } = record;
    if (
      version !== 1 ||
      Object.keys(record).length !== 3 ||
      typeof savedNotes !== "object" ||
      savedNotes === null ||
      Array.isArray(savedNotes) ||
      typeof savedReceipts !== "object" ||
      savedReceipts === null ||
      Array.isArray(savedReceipts)
    )
      throw new ChannelPurposeError(`${this.path} has an invalid purpose state; repair it before retrying`);
    const notes = savedNotes as Record<string, unknown>;
    const receipts = savedReceipts as Record<string, unknown>;
    for (const [id, entry] of Object.entries(notes))
      if (!isDiscordSnowflake(id) || !isPurpose(entry))
        throw new ChannelPurposeError(`${this.path}: entry ${JSON.stringify(id)} is not a channel purpose`);
    for (const [key, receipt] of Object.entries(receipts))
      if (!isReceipt(receipt) || key !== receiptKey(receipt.source, receipt.channel))
        throw new ChannelPurposeError(`${this.path} has an invalid source receipt; repair it before retrying`);
    return { version: 1, notes: notes as Purposes, receipts: receipts as PurposeState["receipts"] };
  }

  /** Manual edits remain unrestricted by source, but retain every earlier receipt. */
  async set(
    id: string,
    purpose: string,
    name: string | undefined,
    now: number,
    source?: PurposeSource,
  ): Promise<ChannelPurpose> {
    const entry: ChannelPurpose = {
      purpose: purposeText(purpose),
      ...(name === undefined ? {} : { name }),
      updatedAt: new Date(now).toISOString(),
    };
    return await this.change(id, entry, source);
  }

  /** A bound retry returns the first clear result without removing a later note. */
  async clear(id: string, source?: PurposeSource): Promise<boolean> {
    return await this.change(id, null, source);
  }

  private change(id: string, entry: ChannelPurpose, source?: PurposeSource): Promise<ChannelPurpose>;
  private change(id: string, entry: null, source?: PurposeSource): Promise<boolean>;
  private async change(
    id: string,
    entry: ChannelPurpose | null,
    source?: PurposeSource,
  ): Promise<ChannelPurpose | boolean> {
    if (!isDiscordSnowflake(id)) throw new ChannelPurposeError(`${JSON.stringify(id)} is not a Discord ID`);
    if (source !== undefined && !isSource(source)) throw new ChannelPurposeError("invalid purpose source identity");
    mkdirSync(this.stateDir, { recursive: true });
    const fail = (m: string) => new ChannelPurposeError(`channel purpose lock ${m}`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const held = takeLock(`${this.path}.lock`, Date.now(), fail);
      if (typeof held !== "string") {
        try {
          const all = this.readState();
          const purpose = entry?.purpose ?? null;
          const previous = source === undefined ? undefined : all.receipts[receiptKey(source, id)];
          if (previous !== undefined) {
            if (previous.purpose !== purpose) throw new ChannelPurposeError("channel purpose source identity conflict");
            return previous.result;
          }
          const result = entry ?? Object.hasOwn(all.notes, id);
          const notes =
            entry === null
              ? Object.fromEntries(Object.entries(all.notes).filter(([key]) => key !== id))
              : { ...all.notes, [id]: entry };
          const receipts = { ...all.receipts };
          if (source !== undefined) receipts[receiptKey(source, id)] = { source, channel: id, purpose, result };
          const next: PurposeState = { version: 1, notes, receipts };
          const tmp = `${this.path}.${process.pid}.tmp`;
          writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
          chmodSync(tmp, 0o600);
          renameSync(tmp, this.path);
          return result;
        } finally {
          held();
        }
      }
      if (Date.now() >= deadline) throw new ChannelPurposeError(`channel purposes are locked (${held})`);
      await Bun.sleep(50);
    }
  }
}
