import { existsSync, renameSync } from "node:fs";
import { carryOver, forwardOf, mergeSpool, removeForward, writeForward } from "./inbox-forward.ts";
import { lockRoute } from "./inbox-spool.ts";
import type { Deps } from "./harness.ts";
import type { MigrateOpts } from "./migrate-capture.ts";
import { refText } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

const LOCK_TRIES = 30;
const LOCK_RETRY_MS = 1_000;
const GONE_INPUT = "typed into the session it was migrated from; that input is gone";

/** A typed attempt's input stays behind in the old session, so on the new one it is held like an ambiguous delivery. */
const carried = (m: QueuedMessage): QueuedMessage =>
  m.attempt?.state === "typed" ? { ...m, attempt: { at: m.attempt.at, state: "ambiguous", detail: GONE_INPUT } } : m;

/**
 * Runs `body` under the route locks of `routes` (no send reads their markers or writes to them meanwhile, see
 * lockRoute), then the inbox locks of every ref (in the order given), retrying while a send or another flush holds one.
 * Every take runs inside the protected region, so a take that throws (an I/O error while writing the lock file, a
 * spool that cannot be read) releases the locks already taken instead of leaving them held until this process exits.
 */
async function underLocks(
  d: Deps,
  routes: readonly SessionRef[],
  refs: readonly SessionRef[],
  opts: MigrateOpts,
  body: () => void,
): Promise<void> {
  const takes = [
    ...routes.map((ref) => () => lockRoute(d.store.root, ref, d.now())),
    ...refs.map((ref) => () => d.store.lockInbox(ref, d.now())),
  ];
  for (let tries = 0; ; tries++) {
    const held: (() => void)[] = [];
    try {
      for (const take of takes) {
        const release = take();
        if (!release) break;
        held.push(release);
      }
      if (held.length === takes.length) {
        body();
        return;
      }
    } finally {
      for (const release of held.reverse()) release();
    }
    if (tries >= LOCK_TRIES) throw new Error(`the inboxes of ${refs.map(refText).join(", ")} stay locked`);
    await opts.sleep(LOCK_RETRY_MS);
  }
}

/**
 * Appends every entry of `src` (and a `.merging` copy a cut-short run left) to `dst`, never rename-overwriting `dst`.
 * The source is renamed aside first, so an append racing the move lands in a fresh source file for a later merge;
 * `carryOver` skips what `dst` already holds and what `src` recorded as settled, so a re-run adds no duplicates.
 */
function mergeFile(src: string, dst: string, map: (m: QueuedMessage) => QueuedMessage): void {
  const aside = `${src}.merging`;
  if (!existsSync(aside) && existsSync(src)) renameSync(src, aside);
  carryOver(aside, src, dst, map);
}

/**
 * Step (6): writes the live redirect on the old inbox naming the new ref, then merges the old entries into the new
 * inbox under both inbox locks; the old inbox's spool moves too. Plain entries stay queued, held stay held, typed become
 * held.
 */
export async function moveInbox(d: Deps, from: SessionRef, to: SessionRef, opts: MigrateOpts): Promise<void> {
  await underLocks(d, [from], [from, to], opts, () => {
    writeForward(d.store.root, from, to);
    const old = d.store.inboxPath(from);
    const next = d.store.inboxPath(to);
    mergeFile(old, next, carried);
    mergeSpool(old, next);
  });
}

/**
 * Step (8): drains what late senders appended to the old path into the new inbox, then removes the live redirect. The
 * old route is held throughout: a send that read the redirect has written before the drain, and none writes until the
 * redirect is gone. Holding the old inbox lock keeps its spool for this drain, so a message spooled by a send that
 * raced the marker cannot be left behind with nothing to move it. Nothing names the replacement afterwards: the old id
 * may be used again by a new session (inbox-forward.ts).
 */
export async function drainForward(d: Deps, from: SessionRef, to: SessionRef, opts: MigrateOpts): Promise<void> {
  await underLocks(d, [from], [from, to], opts, () => {
    d.store.mergeForwarded(to);
    removeForward(d.store.root, from);
  });
}

/**
 * Rollback after step (6) ran: the entries go back to the old inbox (unchanged, held entries still held) and the old
 * inbox is open again. The replacement's route is held too: a send addressed to it directly has written before its lock
 * is taken (which moves its spool into its queue), and none writes until its entries are back on the old inbox. A
 * sender that resolved a lane or role to the replacement meanwhile resolves it again under the route and finds the old
 * session; the replacement's id itself is left naming whatever session uses it next.
 */
export async function moveBack(d: Deps, from: SessionRef, to: SessionRef, opts: MigrateOpts): Promise<void> {
  if (forwardOf(d.store.root, from) === undefined) return;
  await underLocks(d, [from, to], [from, to], opts, () => {
    const old = d.store.inboxPath(from);
    const next = d.store.inboxPath(to);
    removeForward(d.store.root, from);
    mergeFile(next, old, (m) => m);
    mergeSpool(next, old);
  });
}
