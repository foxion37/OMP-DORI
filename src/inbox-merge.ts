import { existsSync, renameSync, rmSync } from "node:fs";
import { basename } from "node:path";
import {
  appendAll,
  appendQueue,
  doneIds,
  doneKeys,
  INBOX_SUFFIX,
  MOVING,
  owedFile,
  readQueue,
  recordKeys,
  spooled,
  spoolKey,
} from "./inbox-files.ts";
import type { QueuedMessage } from "./store-types.ts";

// Moving entries into a queue: the notices owed to the lead (payLead) and a queue's spool (mergeSpool). Each source
// file is renamed aside before its entries are appended, so a move cut short is finished next time, exactly once.

/** An entry's identity: its id; else the spool file it came through (one sent message); else at+from+text. */
const keyOf = (m: QueuedMessage): string =>
  m.id !== undefined
    ? `id:${m.id}`
    : m.spool !== undefined
      ? spoolKey(m.spool)
      : `${m.at}\u0000${m.from}\u0000${m.text}`;

/**
 * Appends the entries of `aside` (a queue renamed aside, its keys still at `<from>.ids`) to the end of `into`, then
 * removes it. The keys `from` recorded as gone move to `into` first and their entries are left behind, so an entry
 * delivered before the move is neither delivered nor queued again after it. An entry `into` already holds under the same
 * key (keyOf), or whose id or spool file it recorded as gone, is not added again. Different ids and different spool
 * files remain distinct even when their timestamps and text match.
 */
function carryOver(aside: string, from: string, into: string): void {
  const done = doneIds(from);
  const known = doneIds(into);
  recordKeys(
    into,
    [...done].filter((k) => !known.has(k)),
  );
  for (const k of done) known.add(k);
  const held = readQueue(into);
  const seen = new Set(held.map(keyOf));
  for (const m of held) for (const k of doneKeys([m])) known.add(k);
  const kept: QueuedMessage[] = [];
  for (const m of readQueue(aside)) {
    if (seen.has(keyOf(m)) || doneKeys([m]).some((k) => known.has(k))) continue;
    seen.add(keyOf(m));
    for (const k of doneKeys([m])) known.add(k);
    kept.push(m);
  }
  appendAll(into, kept);
  rmSync(aside, { force: true });
}

/**
 * Moves the owed notices into the lead's inbox `into`, then the messages spooled for the lead, oldest first; call it
 * under into's inbox lock. The queue is renamed aside first, so a run cut short is finished next time.
 */
export function payLead(root: string, into: string): void {
  const owed = owedFile(root);
  const aside = `${owed}.merging`;
  if (existsSync(aside) || existsSync(owed)) {
    if (!existsSync(aside)) renameSync(owed, aside);
    carryOver(aside, owed, into);
  }
  mergeSpool(owed, into);
}

/**
 * Moves the spooled entries of the queue at `from` to the end of `into`, oldest first, under into's lock. A spooled
 * entry is a message of its own, so it is appended even when an equal one is queued (the same text sent twice in one
 * millisecond stays two messages); only keys recorded as gone are skipped. Each file is renamed aside before its entry
 * is appended and removed after: a `.moving` file left by a move cut short between the two may already be in `into`,
 * and is carried over (skipping it when `into` holds an entry from the same spool file) before the rest. A `.moving`
 * file whose entry already left (`<into>.ids` holds its spool name) is removed without being appended again.
 */
export function mergeSpool(from: string, into: string): void {
  const gone = new Set([...doneIds(from), ...doneIds(into)]);
  for (const f of spooled(from, true).filter((n) => n.endsWith(MOVING))) {
    const name = basename(f)
      .slice(0, -MOVING.length)
      .replace(new RegExp(`${INBOX_SUFFIX}$`), "");
    if (gone.has(spoolKey(name))) {
      rmSync(f, { force: true });
      continue;
    }
    carryOver(f, from, into);
  }
  for (const file of spooled(from)) {
    const name = basename(file).replace(new RegExp(`${INBOX_SUFFIX}$`), "");
    renameSync(file, `${file}${MOVING}`);
    const moved = `${file}${MOVING}`;
    if (gone.has(spoolKey(name))) {
      rmSync(moved, { force: true });
      continue;
    }
    for (const m of readQueue(moved)) if (m.id === undefined || !gone.has(m.id)) appendQueue(into, m);
    rmSync(moved, { force: true });
  }
}
