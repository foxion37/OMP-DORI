import type { Deps } from "./harness.ts";
import { registeredNativeTarget } from "./harness-native.ts";
import { inboxSealed, lockRoute } from "./inbox-spool.ts";
import { sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";

/** How often a pass follows a lane or role that switched sessions while it took the route, before the next pass. */
const RESOLVES = 3;

/**
 * Runs `write` on the inbox of the session `name` resolves to, under that session's route lock and its inbox lock, the
 * lock every rewrite of the queue holds: a flush that read the queue before an unlocked append writes it back without
 * the appended entry, and a native stop that sealed the inbox meanwhile must not receive it (lockRoute). `name` (a
 * lane's or role's record) is resolved again under the route: a lane or role that switched sessions before the route
 * was taken is followed to its new session. Returns the inbox written; undefined while another process holds either
 * lock, or with nothing named: nothing is written, and the next pass tries again.
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
      if (now === undefined) return undefined;
      if (sameSession(now, ref)) {
        if (inboxSealed(d.store.root, ref)) return undefined;
        registeredNativeTarget(d, ref);
        const release = d.store.lockInbox(ref, d.now());
        if (!release) return undefined;
        try {
          write(ref);
          return ref;
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
