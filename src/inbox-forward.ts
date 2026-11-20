import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  appendAll,
  appendQueue,
  doneIds,
  doneKeys,
  INBOX_SUFFIX,
  inboxFile,
  MOVING,
  nonEmpty,
  owedFile,
  readQueue,
  recordKeys,
  spooled,
  spoolKey,
} from "./inbox-files.ts";
import { refFromText, refText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

// Where an inbox went while a migration runs: `<inbox>.jsonl.forward` names the replacement from step 6 until the
// final drain removes it, so it is a live redirect (a send holds the route from reading it to writing its message,
// inbox-spool.ts). Nothing names the replacement after that: herdr pane ids and hc terminal ids are used again for new
// sessions, so a redirect kept on an id would send an unrelated session's messages to the replacement. A sender that
// resolved a lane key or role before the migration finished resolves it again under the route instead (queueMessage).

const MARKER = ".forward";

/** The session this inbox is forwarded to right now, or undefined. */
export function forwardOf(root: string, ref: SessionRef): SessionRef | undefined {
  const marker = `${inboxFile(root, ref)}${MARKER}`;
  return existsSync(marker) ? markerRef(marker) : undefined;
}

const markerRef = (marker: string): SessionRef | undefined => {
  if (!existsSync(marker)) return undefined;
  const text = readFileSync(marker, "utf8").trim();
  return text === "" ? undefined : refFromText(text);
};

/** Writes the redirect in one rename; call it under the inbox's route. */
export function writeForward(root: string, ref: SessionRef, to: SessionRef): void {
  const marker = `${inboxFile(root, ref)}${MARKER}`;
  writeFileSync(`${marker}.tmp`, `${refText(to)}\n`);
  renameSync(`${marker}.tmp`, marker);
}

/** Removes the live redirect; call it under the inbox's route. */
export function removeForward(root: string, ref: SessionRef): void {
  rmSync(`${inboxFile(root, ref)}${MARKER}`, { force: true });
}

/** The old inboxes whose live redirect names `ref`. */
function movedInto(root: string, ref: SessionRef): string[] {
  const dir = join(root, "inbox");
  return readdirSync(dir)
    .filter((f) => f.endsWith(MARKER))
    .map((f) => join(dir, f.slice(0, -MARKER.length)))
    .filter((old) => {
      const to = markerRef(`${old}${MARKER}`);
      return to !== undefined && sameSession(to, ref);
    });
}

/** True when ref's inbox has entries to move in: spooled beside it, or waiting in an old inbox that names it. */
export const mergePending = (root: string, ref: SessionRef): boolean =>
  spooled(inboxFile(root, ref), true).length > 0 ||
  movedInto(root, ref).some((old) => nonEmpty(old) || nonEmpty(`${old}.merging`) || spooled(old, true).length > 0);

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
export function carryOver(aside: string, from: string, into: string, map: (m: QueuedMessage) => QueuedMessage): void {
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
    kept.push(map(m));
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
    carryOver(aside, owed, into, (m) => m);
  }
  mergeSpool(owed, into);
}

/**
 * Moves the entries of every old inbox whose live redirect names `ref` to the end of ref's inbox. Call it under ref's
 * inbox lock. Each old queue is renamed aside first, so an append that races the merge lands in a fresh old file for
 * the next one. The old inbox's spool moves here too: while it names a replacement, only the holder of that inbox's
 * lock moves its spool.
 */
export function mergeForwarded(root: string, ref: SessionRef): void {
  const into = inboxFile(root, ref);
  for (const old of movedInto(root, ref)) {
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
    mergeSpool(old, into);
  }
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
    carryOver(f, from, into, (m) => m);
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
