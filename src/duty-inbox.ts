import type { Deps } from "./harness.ts";
import { lockRoute } from "./inbox-spool.ts";
import { sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";

/** How often a pass follows a lane or role that switched sessions while it took the route, before the next pass. */
const RESOLVES = 3;

/**
 * Runs `write` on the inbox the session `name` resolves to (the one a running migration forwards it to, if one does)
 * under that session's route lock and that inbox's lock, the lock every rewrite of the queue holds: a flush that read
 * the queue before an unlocked append writes it back without the appended entry, and a migration that moved the inbox
 * meanwhile would leave it behind (lockRoute). `name` (a lane's or role's record) is resolved again under the route: a
 * migration that finished before the route was taken left nothing on the old id, which a new session may use. Returns
 * the inbox written; undefined while another process holds either lock, or with nothing named: nothing is written, and
 * the next pass tries again.
 */
export function underInboxLock(
  d: Deps,
  name: () => SessionRef | undefined,
  write: (inbox: SessionRef) => void,
): SessionRef | undefined {
  for (let ref = name(), tries = 0; ref !== undefined && tries < RESOLVES; tries++) {
    const route = lockRoute(d.store.root, ref, d.now());
    if (!route) return undefined;
    let now: SessionRef | undefined;
    try {
      now = name();
      if (now === undefined || sameSession(now, ref)) {
        const inbox = d.store.destination(ref);
        const release = d.store.lockInbox(inbox, d.now());
        if (!release) return undefined;
        try {
          write(inbox);
          return inbox;
        } finally {
          release();
        }
      }
    } finally {
      route();
    }
    ref = now;
  }
  return undefined;
}
