import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendQueue, inboxFile, owedFile, spoolDir, spooled } from "./inbox-files.ts";
import { forwardOf, mergeSpool } from "./inbox-forward.ts";
import { takeInboxLock } from "./inbox-lock.ts";
import { Refusal } from "./refusal.ts";
import { refText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

// A message sent while another process holds the inbox lock is written to a file of its own in `<inbox>.spool/`, and
// the holder of the lock moves it into the queue. A holder rewrites the queue from what it read, so an append beside it
// would be lost; one file per message means nothing it moves can still be written to. The entry keeps the file's name
// (`spool`), so a move cut short adds it once and an equal message stays a message of its own.

const ROUTE_TRIES = 40;
const ROUTE_RETRY_MS = 50;
let spoolSeq = 0;

/** Spools `msg` for the queue at `path` in a file of its own, written aside and renamed in whole. */
export function spoolMessage(path: string, msg: QueuedMessage): void {
  mkdirSync(spoolDir(path), { recursive: true });
  const name = `${String(msg.at).padStart(15, "0")}-${String(spoolSeq++).padStart(9, "0")}-${randomUUID()}`;
  const file = join(spoolDir(path), `${name}.jsonl`);
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...msg, spool: name })}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * Moves ref's spool into its queue; call it under ref's inbox lock. Not while a `.forward` marker names another inbox:
 * the holder of that inbox's lock moves it then (mergeForwarded), so no spooled file has two movers. Returns whether
 * this inbox moves its own spool.
 */
export function mergeOwnSpool(root: string, ref: SessionRef): boolean {
  if (forwardOf(root, ref) !== undefined) return false;
  const path = inboxFile(root, ref);
  mergeSpool(path, path);
  return true;
}

/**
 * Takes ref's inbox lock (see Store.lockInbox) and moves its spool into the queue before anything reads it. The release
 * moves the spool in again before it lets go, and once it has let go takes the lock back for a file spooled meanwhile:
 * a sender spools only while the lock is held and tries the lock once after (appendOrSpool), so whichever of the two
 * looks last finds the file, and a message for an inbox that is never flushed (a lead with no agent) still reaches it.
 */
export function lockQueue(root: string, ref: SessionRef, now: number): (() => void) | undefined {
  const path = inboxFile(root, ref);
  const take = (): (() => void) | undefined => {
    const unlock = takeInboxLock(`${path}.lock`, now);
    if (!unlock) return undefined;
    try {
      mergeOwnSpool(root, ref);
    } catch (e) {
      unlock();
      throw e;
    }
    return unlock;
  };
  const held = take();
  if (!held) return undefined;
  return () => {
    for (let unlock: (() => void) | undefined = held; unlock;) {
      let owns = false;
      try {
        owns = mergeOwnSpool(root, ref);
      } finally {
        unlock();
      }
      unlock = owns && spooled(path).length > 0 ? take() : undefined;
    }
  };
}

/**
 * Takes the route lock of ref's inbox (`<inbox>.route`, judged stale like the inbox lock). A sender holds it from
 * reading the `.forward` marker to writing its message, and a migration while it writes, drains or removes the marker
 * (migrate-inbox.ts), so a message is never written where the marker it read no longer points.
 */
export function lockRoute(root: string, ref: SessionRef, now: number): (() => void) | undefined {
  return takeInboxLock(`${inboxFile(root, ref)}.route`, now);
}

/**
 * Where a message sent to `ref` belongs once its route is held: the inbox the live `.forward` chain of a running
 * migration leads to. A finished migration leaves nothing behind (inbox-forward.ts), so a name with no marker is its
 * own destination, also when its id is used again by a new session.
 */
export function destinationOf(root: string, ref: SessionRef): SessionRef {
  const seen = new Set<string>();
  for (let at = ref; ;) {
    const key = `${at.runtime}:${at.id}`;
    if (seen.has(key)) return at;
    seen.add(key);
    const next = forwardOf(root, at);
    if (next === undefined || sameSession(next, at)) return at;
    at = next;
  }
}

/**
 * Appends `msg` to ref's queue under its lock. While another process holds the lock it is spooled for that holder, and
 * the lock is tried once more: a holder that let go before the file was written did not see it (lockQueue).
 */
function appendOrSpool(root: string, ref: SessionRef, msg: QueuedMessage): void {
  const release = lockQueue(root, ref, msg.at);
  if (!release) {
    spoolMessage(inboxFile(root, ref), msg);
    lockQueue(root, ref, msg.at)?.();
    return;
  }
  try {
    appendQueue(inboxFile(root, ref), msg);
  } finally {
    release();
  }
}

/** Where a sent message went: queued for the inbox `at` (the one its sender flushes), or kept for the lead. */
export type Queued = { kind: "queued"; at: SessionRef } | { kind: "kept" };

/**
 * Queues `msg` for the inbox its name resolves to under the route. `recheck` resolves the name this send used again
 * under the route: a migration or a lane switch that finished while the caller was between resolving and taking the
 * route moves the message to the session it now names, at once. The route is held until the message is written (queued
 * or spooled), so a migration cannot drain between the write and the redirect's removal. A held route is waited for
 * briefly, without blocking the process; then a message addressed to the logical lead role (`namedLead`) is kept for
 * it like an owed notice ("kept": payLead moves it once the route is free), even if that role changed or disappeared.
 * Reports, READYs and held-delivery notices are never dropped; an explicit session send is refused instead.
 */
export async function queueMessage(
  root: string,
  ref: SessionRef,
  msg: QueuedMessage,
  namedLead: boolean,
  recheck?: () => SessionRef,
): Promise<Queued> {
  let target = ref;
  for (let tries = 0; ;) {
    const current = target;
    const route = lockRoute(root, current, msg.at);
    if (route) {
      let moved: SessionRef | undefined;
      try {
        moved = recheck?.();
        if (moved === undefined || sameSession(moved, current)) {
          const at = destinationOf(root, current);
          appendOrSpool(root, at, msg);
          return { kind: "queued", at };
        }
      } finally {
        route();
      }
      target = moved;
      continue;
    }
    if (tries++ >= ROUTE_TRIES) {
      if (namedLead) {
        spoolMessage(owedFile(root), msg);
        return { kind: "kept" };
      }
      throw new Refusal(`the inbox of ${refText(current)} is being moved; send again`);
    }
    await Bun.sleep(ROUTE_RETRY_MS);
  }
}
