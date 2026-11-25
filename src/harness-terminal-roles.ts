import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { refText, sameSession } from "./refs.ts";
import { parseRef, type SessionRef } from "./runtime/types.ts";
import { RESERVED_KEYS, type Role } from "./store-types.ts";

/**
 * A terminal role (`cataly harness up` or `role` on Tern) has no ownership receipt. Retire registrations only, and only
 * once every registered session is proven gone; never close any terminal.
 */
export async function retireTerminalRoles(d: Deps): Promise<number> {
  const entries = Object.entries(d.store.roles()) as [Role, SessionRef][];
  const byRuntime = new Map<SessionRef["runtime"], SessionRef[]>();
  for (const [role, ref] of entries) {
    if (!RESERVED_KEYS.includes(role) || ref.runtime === "headless" || !parseRef(refText(ref)))
      throw new Refusal(`role ${role} has no verified terminal address; its registration was left unchanged`);
    const refs = byRuntime.get(ref.runtime) ?? [];
    refs.push(ref);
    byRuntime.set(ref.runtime, refs);
  }
  for (const [kind, refs] of byRuntime) {
    const rt = d.runtimes.terminal(kind);
    try {
      const listed = await rt.list();
      for (const ref of refs) {
        if (listed.some((row) => sameSession(row.ref, ref)) || (await rt.probe(ref)).status !== "gone")
          throw new Error(`${refText(ref)} is still present or its exit is not proven`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Refusal(
        `Terminal roles left unchanged: ${reason}. Close your ${kind} sessions yourself, then retry cataly harness stop.`,
      );
    }
  }
  // All registered refs were proven gone before changing any registration.
  d.store.clearRoles(entries);
  return entries.length;
}
