import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendQueue, inboxFile, owedFile, spoolDir, spooled } from "./inbox-files.ts";
import { mergeSpool } from "./inbox-merge.ts";
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

/** Moves ref's spool into its queue; call it under ref's inbox lock. */
export function mergeOwnSpool(root: string, ref: SessionRef): void {
  const path = inboxFile(root, ref);
  mergeSpool(path, path);
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
    const unlock = lockInboxFiles(root, ref, now);
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
      try {
        mergeOwnSpool(root, ref);
      } finally {
        unlock();
      }
      unlock = spooled(path).length > 0 ? take() : undefined;
    }
  };
}

/**
 * Takes the route lock of ref's inbox (`<inbox>.route`, judged stale like the inbox lock). A sender holds it from
 * resolving the session to writing its message, and a native stop holds it while it seals the inbox, so a message is
 * never written to an inbox sealed after its sender looked.
 */
export function lockRoute(root: string, ref: SessionRef, now: number): (() => void) | undefined {
  return takeInboxLock(`${inboxFile(root, ref)}.route`, now);
}

/** Pins the queue and its spool without merging them, so a shutdown preflight leaves pending entries alone. */
export function lockInboxFiles(root: string, ref: SessionRef, now: number): (() => void) | undefined {
  return takeInboxLock(`${inboxFile(root, ref)}.lock`, now);
}

const sealedPath = (root: string, ref: SessionRef): string => `${inboxFile(root, ref)}.sealed`;

/**
 * Seals an owned native role's UUID under its route lock, before shutdown can be admitted. The seal survives a
 * partial stop or a crash before unregistering: an explicit or stale address must never queue onto the old UUID.
 */
export function sealNativeInbox(root: string, ref: SessionRef): void {
  try {
    writeFileSync(sealedPath(root, ref), "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function inboxSealed(root: string, ref: SessionRef): boolean {
  if (ref.runtime !== "headless") return false;
  try {
    lstatSync(sealedPath(root, ref));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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
 * under the route: a lane switch that finished while the caller was between resolving and taking the route moves the
 * message to the session it now names, at once. The route is held until the message is written (queued or spooled), so
 * a native stop cannot seal the inbox between the check and the write. A held route is waited for briefly, without
 * blocking the process; then a message addressed to the logical lead role (`namedLead`) is kept for it like an owed
 * notice ("kept": payLead moves it once the route is free), even if that role changed or disappeared. Reports, READYs
 * and held-delivery notices are never dropped; an explicit session send is refused instead.
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
          if (inboxSealed(root, current)) {
            if (namedLead) {
              spoolMessage(owedFile(root), msg);
              return { kind: "kept" };
            }
            throw new Refusal(`the native inbox of ${refText(current)} is closed to new messages`);
          }
          appendOrSpool(root, current, msg);
          return { kind: "queued", at: current };
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
      throw new Refusal(`the inbox route of ${refText(current)} is busy; send again`);
    }
    await Bun.sleep(ROUTE_RETRY_MS);
  }
}
