import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refFromText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

// Inbox files: one JSONL queue per session. A herdr pane keeps the name it had before runtimes existed (`w1_p3.jsonl`),
// so queues written by an older binary drain; every other runtime is prefixed (`hc--t7.jsonl`). A `.forward` file beside
// an inbox (`w1_p3.jsonl.forward`, holding a ref) says that session moved: new messages go to the ref's inbox, and
// entries an older writer still appends to the old file are merged into it by the next flush.

const HC_PREFIX = "hc--";
const SUFFIX = ".jsonl";

export function inboxFile(root: string, ref: SessionRef): string {
  const name = ref.runtime === "herdr" ? ref.id.replaceAll(":", "_") : `${HC_PREFIX}${ref.id}`;
  return join(root, "inbox", `${name}${SUFFIX}`);
}

function refOfFile(name: string): SessionRef {
  const stem = name.slice(0, -SUFFIX.length);
  return stem.startsWith(HC_PREFIX)
    ? { runtime: "hc", id: stem.slice(HC_PREFIX.length) }
    : { runtime: "herdr", id: stem.replaceAll("_", ":") };
}

/** Every session that has an inbox file, empty or not. */
export const inboxRefs = (root: string): SessionRef[] =>
  readdirSync(join(root, "inbox"))
    .filter((f) => f.endsWith(SUFFIX))
    .map(refOfFile);

export function readQueue(path: string): QueuedMessage[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as QueuedMessage);
}

export const writeQueue = (path: string, msgs: readonly QueuedMessage[]): void =>
  writeFileSync(path, msgs.map((m) => `${JSON.stringify(m)}\n`).join(""));

export const appendQueue = (path: string, msg: QueuedMessage): void => appendFileSync(path, `${JSON.stringify(msg)}\n`);

// A queued message with an `id` (a duty notice) is queued for a session once: its id is recorded in `<inbox>.ids` when
// it leaves the queue (delivered or acked), so a pass that queues it again after that finds it there. The id is
// recorded before the queue is rewritten without it, and the queue is read without the ids recorded there: a process
// stopped between the two writes leaves an entry that reads as gone, never one delivered a second time.
const idsFile = (path: string): string => `${path}.ids`;

export const doneIds = (path: string): Set<string> =>
  new Set(existsSync(idsFile(path)) ? readFileSync(idsFile(path), "utf8").split("\n").filter(Boolean) : []);

const recordIds = (path: string, ids: readonly string[]): void => {
  if (ids.length > 0) appendFileSync(idsFile(path), ids.map((id) => `${id}\n`).join(""));
};

export const markDone = (path: string, msgs: readonly QueuedMessage[]): void =>
  recordIds(
    path,
    msgs.flatMap((m) => (m.id === undefined ? [] : [m.id])),
  );

/** The session's queue as the flush sees it: entries whose id was recorded as gone are left out. */
export function pendingQueue(path: string): QueuedMessage[] {
  const done = doneIds(path);
  return readQueue(path).filter((m) => m.id === undefined || !done.has(m.id));
}

/** The session this inbox was forwarded to, or undefined. */
export function forwardOf(root: string, ref: SessionRef): SessionRef | undefined {
  const marker = `${inboxFile(root, ref)}.forward`;
  if (!existsSync(marker)) return undefined;
  const text = readFileSync(marker, "utf8").trim();
  return text === "" ? undefined : refFromText(text);
}

/** The old inbox files whose `.forward` marker names `ref`. */
function forwardedInto(root: string, ref: SessionRef): string[] {
  const dir = join(root, "inbox");
  return readdirSync(dir)
    .filter((f) => f.endsWith(`${SUFFIX}.forward`))
    .map((f) => join(dir, f.slice(0, -".forward".length)))
    .filter((old) => {
      const to = readFileSync(`${old}.forward`, "utf8").trim();
      return to !== "" && sameSession(refFromText(to), ref);
    });
}

/** True when an old inbox forwarded into `ref` still holds entries to merge. */
export const forwardPending = (root: string, ref: SessionRef): boolean =>
  forwardedInto(root, ref).some((old) => readQueue(old).length > 0 || readQueue(`${old}.merging`).length > 0);

const keyOf = (m: QueuedMessage): string =>
  m.id === undefined ? `${m.at}\u0000${m.from}\u0000${m.text}` : `id:${m.id}`;

/**
 * Appends the entries of `aside` (a queue renamed aside, its ids still at `<from>.ids`) to the end of `into`, then
 * removes it. The ids `from` recorded as gone are recorded for `into` first and their entries are left behind, so a
 * notice delivered before the move is neither delivered nor queued again after it. An entry whose id `into` already
 * holds or recorded as gone, or an id-less entry it already holds (keyed by at+from+text), is not added again.
 * Different ids remain distinct even when their timestamps and text match after a clock or runtime reset.
 */
export function carryOver(aside: string, from: string, into: string, map: (m: QueuedMessage) => QueuedMessage): void {
  const done = doneIds(from);
  const known = doneIds(into);
  recordIds(
    into,
    [...done].filter((id) => !known.has(id)),
  );
  const held = readQueue(into);
  const seen = new Set(held.map(keyOf));
  const ids = new Set([...done, ...known, ...held.flatMap((m) => (m.id === undefined ? [] : [m.id]))]);
  for (const m of readQueue(aside)) {
    if ((m.id !== undefined && ids.has(m.id)) || seen.has(keyOf(m))) continue;
    seen.add(keyOf(m));
    if (m.id !== undefined) ids.add(m.id);
    appendQueue(into, map(m));
  }
  rmSync(aside, { force: true });
}

// Notices for the lead found while no lead is registered (a lost lane's LOST) wait in `duty/lead.jsonl`, a queue of
// their own outside any lane record, so a lane started again under the same key cannot drop one.
const owedFile = (root: string): string => join(root, "duty", "lead.jsonl");

export function oweLead(root: string, msg: QueuedMessage & { id: string }): void {
  if (!readQueue(owedFile(root)).some((m) => m.id === msg.id)) appendQueue(owedFile(root), msg);
}

/** Moves the owed notices into the lead's inbox `into`; renamed aside first, so a run cut short is finished next time. */
export function payLead(root: string, into: string): void {
  const owed = owedFile(root);
  const aside = `${owed}.merging`;
  if (!existsSync(aside) && !existsSync(owed)) return;
  if (!existsSync(aside)) renameSync(owed, aside);
  carryOver(aside, owed, into, (m) => m);
}

/**
 * Moves the entries of every old inbox forwarded into `ref` to the end of ref's inbox. Call it under ref's inbox lock.
 * The old file is renamed aside first, so an append that races the merge lands in a fresh old file for the next one.
 */
export function mergeForwarded(root: string, ref: SessionRef): void {
  const into = inboxFile(root, ref);
  for (const old of forwardedInto(root, ref)) {
    const aside = `${old}.merging`;
    for (let pass = 0; pass < 2; pass++) {
      if (!existsSync(aside)) {
        try {
          renameSync(old, aside);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
          throw e;
        }
      }
      carryOver(aside, old, into, (m) => m);
    }
  }
}
