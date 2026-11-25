import type { Deps } from "./harness.ts";
import { resolveShortRef } from "./refs.ts";
import { Refusal } from "./refusal.ts";
import { parseRef, type SessionRef } from "./runtime/types.ts";
import type { Store } from "./store.ts";
import { RESERVED_KEYS, type Role } from "./store-types.ts";

const ROLES_ALL: readonly Role[] = RESERVED_KEYS;
const isRole = (target: string): target is Role => (ROLES_ALL as readonly string[]).includes(target);

/** Every session this home has registered, as a role or a lane of any status: what a shortened headless ref names. */
export const knownRefs = (store: Pick<Store, "roles" | "lanes">): SessionRef[] => [
  ...Object.values(store.roles()),
  ...store.lanes().map((l) => l.sessionRef),
];

/**
 * Where a send goes, in this order: a headless ref (it may be shortened to the unique prefix the lane board shows), a
 * role, an open lane key, a Tern ref (`tern:42`).
 */
export function resolveTarget(d: Deps, target: string): SessionRef {
  if (target.startsWith("headless:")) {
    const ref = parseRef(target) ?? resolveShortRef(target, knownRefs(d.store));
    if (ref) return ref;
    throw new Refusal(`${target} is not a session ref (headless:<uuid or unique prefix>)`);
  }
  if (isRole(target)) {
    const ref = d.store.roles()[target];
    if (!ref) throw new Refusal(`no ${target} session registered (cataly harness role ${target} <ref>)`);
    return ref;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") return lane.sessionRef;
  const bare = parseRef(target);
  if (bare) return bare;
  throw new Refusal(`unknown target ${target}: not a session ref, role or open lane`);
}
