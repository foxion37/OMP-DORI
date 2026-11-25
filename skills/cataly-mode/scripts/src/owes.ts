/**
 * A Discord owner request stays owed until its exact read mark and complete reply receipt exist.
 * Terminal output, reactions alone and unrelated sends are not answers; receipts without a request ID never are.
 * The CLI records all accepted parts only after the complete reply succeeds. Capped snapshots retain stale-owe limits.
 * Writer locks protect deduplication and atomic publication; corrupt lines cannot swallow the next admitted record.
 * Continuation limits are unchanged.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";
import { MessengerError } from "./messenger/http.ts";
import { readLines, updateLines } from "./owes-file.ts";

/** An obligation older than this is stale: a crash must not resurrect yesterday's unanswered message. */
export const OWE_TTL_MS = 30 * 60_000;
/** Continuations per owe before the gate gives up loudly rather than looping the session forever. */
export const MAX_CONTINUATIONS = 3;
export type InboundOwe = {
  /** `<channel>:<message>` — the Discord ids already identify the message uniquely. */
  readonly id: string;
  readonly channel: string;
  readonly message: string;
  readonly at: number;
  readonly text: string;
};

type SentReceipt = {
  readonly deliveryId: string;
  readonly requestId: string;
  readonly channel: string;
  readonly remoteIds: readonly string[];
  readonly at: number;
};
type MarkReceipt = { readonly channel: string; readonly message: string; readonly at: number };

const dir = (stateDir: string): string => join(stateDir, "owes");
const inboundPath = (stateDir: string): string => join(dir(stateDir), "inbound.jsonl");
const sentPath = (stateDir: string): string => join(dir(stateDir), "sent.jsonl");
const marksPath = (stateDir: string): string => join(dir(stateDir), "marks.jsonl");
const attemptsPath = (stateDir: string): string => join(dir(stateDir), "attempts.json");

const ensureDir = (stateDir: string): void => {
  mkdirSync(dir(stateDir), { recursive: true, mode: 0o700 });
};

/** A torn or foreign line is skipped, never fatal: a broken ledger must not stop the session from settling. */
const parse = <T>(line: string, valid: (v: unknown) => v is T): T | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return valid(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const isOwe = (v: unknown): v is InboundOwe => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Partial<InboundOwe>;
  return (
    typeof o.id === "string" &&
    typeof o.channel === "string" &&
    typeof o.message === "string" &&
    typeof o.at === "number" &&
    Number.isFinite(o.at) &&
    typeof o.text === "string"
  );
};

const isReceipt = (v: unknown): v is SentReceipt => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Partial<SentReceipt>;
  const request = typeof r.requestId === "string" ? /^([1-9]\d{0,19}):([1-9]\d{0,19})$/.exec(r.requestId) : null;
  return (
    isDiscordSnowflake(r.channel) &&
    request?.[1] === r.channel &&
    isDiscordSnowflake(request[2]) &&
    Array.isArray(r.remoteIds) &&
    r.remoteIds.length > 0 &&
    r.remoteIds.every(isDiscordSnowflake) &&
    new Set(r.remoteIds).size === r.remoteIds.length &&
    r.deliveryId === `discord:${r.channel}:${r.remoteIds[0]}` &&
    typeof r.at === "number" &&
    Number.isFinite(r.at)
  );
};

const isMark = (v: unknown): v is MarkReceipt => {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Partial<MarkReceipt>;
  return (
    typeof m.channel === "string" && typeof m.message === "string" && typeof m.at === "number" && Number.isFinite(m.at)
  );
};

/**
 * The obligation lines in one monitor delivery: `INBOUND discord <ch> <msg> from=owner ref=- "<text>"`, optionally
 * behind the `[name] ` prefix every monitor line carries.
 */
export const owesInText = (text: string, at: number): InboundOwe[] => {
  const out: InboundOwe[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^(?:\[[^\]]*\] )?/, "").trimEnd();
    const head = /^INBOUND discord (\d{1,20}) (\d{1,20}) from=owner\b/.exec(line);
    if (!head) continue;
    const channel = head[1]!;
    const message = head[2]!;
    const quoted = /^INBOUND discord \d{1,20} \d{1,20} from=owner ref=\S* (.*)$/.exec(line);
    let body = quoted?.[1] ?? "";
    try {
      const decoded: unknown = JSON.parse(body);
      if (typeof decoded === "string") body = decoded;
    } catch {
      // The raw remainder is still the owner's text; keep it rather than drop the obligation.
    }
    out.push({ id: `${channel}:${message}`, channel, message, at, text: body.slice(0, 500) });
  }
  return out;
};

/** Publishes obligations from one delivery; the count acknowledges only committed new message IDs. */
export const recordOwes = async (stateDir: string, text: string, at: number, signal?: AbortSignal): Promise<number> => {
  const found = owesInText(text, at);
  if (found.length === 0) return 0;
  ensureDir(stateDir);
  return await updateLines(
    inboundPath(stateDir),
    (previous) => {
      const known = new Set(previous.map((line) => parse(line, isOwe)?.id));
      const fresh: string[] = [];
      for (const owe of found) {
        if (known.has(owe.id)) continue;
        known.add(owe.id);
        fresh.push(JSON.stringify(owe));
      }
      return { lines: fresh.length ? [...previous, ...fresh] : previous, value: fresh.length };
    },
    signal,
  );
};

/** Records one complete reply, after every part was accepted, for exactly the named owner request. */
export const recordSent = async (
  stateDir: string,
  channel: string,
  message: string,
  remoteIds: readonly string[],
  at: number,
): Promise<void> => {
  const receipt: SentReceipt = {
    deliveryId: `discord:${channel}:${remoteIds[0]}`,
    requestId: `${channel}:${message}`,
    channel,
    remoteIds,
    at,
  };
  if (!isReceipt(receipt)) throw new MessengerError("discord send: incomplete delivery receipt; outcome uncertain", 0);
  ensureDir(stateDir);
  await updateLines(sentPath(stateDir), (previous) => ({
    lines: [...previous, JSON.stringify(receipt)],
    value: undefined,
  }));
};

/**
 * Records that the owner's exact message got its read receipt. A send on the channel does not imply it: the owner
 * said twice that the answer arrived with no reaction on their message, which reads as being ignored. A mark names
 * one message, so nothing else can stand in for it.
 */
export const recordMark = async (stateDir: string, channel: string, message: string, at: number): Promise<void> => {
  if (!/^\d{1,20}$/.test(channel) || !/^\d{1,20}$/.test(message)) return;
  ensureDir(stateDir);
  await updateLines(marksPath(stateDir), (previous) => ({
    lines: [...previous, JSON.stringify({ channel, message, at })],
    value: undefined,
  }));
};

export const sentReceipts = (stateDir: string): SentReceipt[] =>
  readLines(sentPath(stateDir))
    .map((line) => parse(line, isReceipt))
    .filter((r): r is SentReceipt => r !== undefined);

/**
 * Both the complete reply and read mark must name this exact request and follow its admission.
 * A successful send is evidence of API acceptance, not proof that the owner read the answer.
 */
export const openOwes = (stateDir: string, now: number): InboundOwe[] => {
  const receipts = sentReceipts(stateDir);
  const marks = readLines(marksPath(stateDir))
    .map((line) => parse(line, isMark))
    .filter((m): m is MarkReceipt => m !== undefined);
  const seen = new Set<string>();
  const open: InboundOwe[] = [];
  for (const line of readLines(inboundPath(stateDir))) {
    const owe = parse(line, isOwe);
    if (!owe || seen.has(owe.id)) continue;
    seen.add(owe.id);
    if (now - owe.at > OWE_TTL_MS) continue;
    const answered = receipts.some((r) => r.requestId === owe.id && r.channel === owe.channel && r.at >= owe.at);
    const marked = marks.some((m) => m.channel === owe.channel && m.message === owe.message && m.at >= owe.at);
    if (answered && marked) continue;
    open.push(owe);
  }
  return open.sort((a, b) => a.at - b.at);
};

/** Counts one blocked settle against each open obligation and returns the running totals. */
export const bumpAttempts = (stateDir: string, ids: readonly string[]): Record<string, number> => {
  ensureDir(stateDir);
  const path = attemptsPath(stateDir);
  // A damaged counter must not turn a settle into a crash: the worst case is one extra continuation.
  const previous = ((): Record<string, number> => {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return typeof value === "object" && value !== null ? (value as Record<string, number>) : {};
    } catch {
      return {};
    }
  })();
  const next: Record<string, number> = {};
  for (const id of ids) next[id] = (previous[id] ?? 0) + 1;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return next;
};

/** Supported CLI guidance with exact per-message mark commands, not an unavailable helper alias. */
export const reminder = (owes: readonly InboundOwe[]): string => {
  // Bound the reminder, but each listed request still needs its own linked reply.
  const shown = owes.slice(0, 5);
  const lines = shown.flatMap((owe) => [
    `- channel ${owe.channel}, owner message ${owe.message} (${new Date(owe.at).toISOString()}): ${JSON.stringify(owe.text)}`,
    `  cataly react discord --to ${owe.channel} --message ${owe.message}`,
  ]);
  if (owes.length > shown.length) lines.push(`- and ${owes.length - shown.length} more`);
  return [
    "BLOCKED: a recent owner message is missing one or both local Discord receipts.",
    "Check what remains before acting: do not duplicate an accepted answer or reaction. Use each mark command only if missing.",
    '  cataly send discord --to <channel> --reply <owner message id> --text "<the answer you just gave>"',
    ...lines,
  ].join("\n");
};
