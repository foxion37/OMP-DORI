import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

// Inbox files: one JSONL queue per session. A herdr pane keeps the name it had before runtimes existed (`w1_p3.jsonl`),
// so queues written by an older binary drain; every other runtime is prefixed (`hc--t7.jsonl`). A queue is written aside
// and renamed in whole (writeQueue), so a reader that does not hold the inbox lock still reads a whole queue and never
// half of one. Where an inbox moved is recorded beside it (inbox-forward.ts). A message sent while the inbox lock is
// held waits in `<inbox>.spool/` for the holder (inbox-spool.ts).

export const INBOX_SUFFIX = ".jsonl";
export const MOVING = ".moving";
const HC_PREFIX = "hc--";
const SPOOL = ".spool";

export function inboxFile(root: string, ref: SessionRef): string {
  const name = ref.runtime === "herdr" ? ref.id.replaceAll(":", "_") : `${HC_PREFIX}${ref.id}`;
  return join(root, "inbox", `${name}${INBOX_SUFFIX}`);
}

export function refOfInbox(name: string): SessionRef {
  const stem = name.slice(0, -INBOX_SUFFIX.length);
  return stem.startsWith(HC_PREFIX)
    ? { runtime: "hc", id: stem.slice(HC_PREFIX.length) }
    : { runtime: "herdr", id: stem.replaceAll("_", ":") };
}

/**
 * Every session with queued messages, or messages spooled for its queue. A queue another writer left unreadable keeps
 * its inbox in the list: the pass then reports that inbox alone (duty.ts) instead of losing every other inbox and lane.
 */
export const queuedRefs = (root: string): SessionRef[] =>
  [
    ...new Set(
      readdirSync(join(root, "inbox"))
        .map((f) => (f.endsWith(`${INBOX_SUFFIX}${SPOOL}`) ? f.slice(0, -SPOOL.length) : f))
        .filter((f) => f.endsWith(INBOX_SUFFIX)),
    ),
  ]
    .map(refOfInbox)
    .filter((ref) => {
      const path = inboxFile(root, ref);
      try {
        return pendingQueue(path).length > 0 || spooled(path, true).length > 0;
      } catch {
        return true;
      }
    });

export function readQueue(path: string): QueuedMessage[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as QueuedMessage);
}

/** Rewrites the queue through one rename: a reader without the inbox lock sees the old queue or the new one. */
export const writeQueue = (path: string, msgs: readonly QueuedMessage[]): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, msgs.map((m) => `${JSON.stringify(m)}\n`).join(""));
  renameSync(tmp, path);
};

export const appendQueue = (path: string, msg: QueuedMessage): void => appendFileSync(path, `${JSON.stringify(msg)}\n`);

export const appendAll = (path: string, msgs: readonly QueuedMessage[]): void =>
  appendFileSync(path, msgs.map((m) => `${JSON.stringify(m)}\n`).join(""));

/** True when `path` holds bytes: an entry to move in, judged without parsing a queue a holder may be rewriting. */
export const nonEmpty = (path: string): boolean => {
  try {
    return statSync(path).size > 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};

// A queued message with an `id` (a duty notice) is queued for a session once: its id is recorded in `<inbox>.ids` when
// it leaves the queue (delivered or acked), so a pass that queues it again after that finds it there. A spooled entry's
// file name is recorded the same way (`spool:<name>`): it is one message of its own, and a move or a flush cut short
// must not deliver it twice. Keys are recorded before the queue is rewritten without the entry, and the queue is read
// without the keys recorded there, so a process stopped between the two writes leaves an entry that reads as gone,
// whichever identity settles it.
const idsFile = (path: string): string => `${path}.ids`;

export const doneIds = (path: string): Set<string> =>
  new Set(existsSync(idsFile(path)) ? readFileSync(idsFile(path), "utf8").split("\n").filter(Boolean) : []);

export const recordKeys = (path: string, keys: readonly string[]): void => {
  if (keys.length > 0) appendFileSync(idsFile(path), keys.map((k) => `${k}\n`).join(""));
};

/** A spooled entry's identity in `<inbox>.ids`: its file name, so a leftover `.moving` file is not queued again. */
export const spoolKey = (name: string): string => `spool:${name}`;

/** The keys `markDone` records for `msgs`: their `id`, and the spool file a spooled entry came through. */
export const doneKeys = (msgs: readonly QueuedMessage[]): string[] =>
  msgs.flatMap((m) => [...(m.id === undefined ? [] : [m.id]), ...(m.spool === undefined ? [] : [spoolKey(m.spool)])]);

export const markDone = (path: string, msgs: readonly QueuedMessage[]): void => recordKeys(path, doneKeys(msgs));

/** True when `m` already left the queue under either identity: its id, or the spool file it came through. */
export const settled = (m: QueuedMessage, done: ReadonlySet<string>): boolean =>
  (m.id !== undefined && done.has(m.id)) || (m.spool !== undefined && done.has(spoolKey(m.spool)));

/** The session's queue as the flush sees it: entries recorded as gone under their id or spool file are left out. */
export function pendingQueue(path: string): QueuedMessage[] {
  const done = doneIds(path);
  return readQueue(path).filter((m) => !settled(m, done));
}

export const spoolDir = (path: string): string => `${path}${SPOOL}`;

/** The files spooled for the queue at `path` (`moving`: those a holder renamed aside to move), oldest first. */
export function spooled(path: string, moving = false): string[] {
  const dir = spoolDir(path);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(INBOX_SUFFIX) || (moving && f.endsWith(`${INBOX_SUFFIX}${MOVING}`)))
    .sort()
    .map((f) => join(dir, f));
}

// Notices for the lead found while no lead is registered (a lost lane's LOST) wait in `duty/lead.jsonl`, a queue of
// their own outside any lane record, so a lane started again under the same key cannot drop one. A message for the
// lead whose route stays held (inbox-spool.ts) waits in that queue's spool, one file per message.
export const owedFile = (root: string): string => join(root, "duty", "lead.jsonl");

export function oweLead(root: string, msg: QueuedMessage & { id: string }): void {
  if (!readQueue(owedFile(root)).some((m) => m.id === msg.id)) appendQueue(owedFile(root), msg);
}
