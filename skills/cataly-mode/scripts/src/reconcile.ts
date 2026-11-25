import { formatRef, type SessionInfo } from "../../../../src/runtime/types.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";

export type PaneState = "live" | "vanished" | "unassigned" | "unverified";

/** Compare registrations with the listing; a lost native readback is neither live nor vanished. */
export const reconcilePanes = (
  lanes: readonly Lane[],
  sessions: readonly SessionInfo[],
): { lanes: { key: string; status: string; pane: string | null; paneState: PaneState }[]; unregistered: string[] } => {
  const listed = new Map(sessions.map((s) => [formatRef(s.ref), s]));
  const refOf = (lane: Lane) => sessionOf(lane);
  // A closed lane owns no pane: one left open by a failed close is unregistered, as in sync.
  const registered = new Set(
    lanes.flatMap((l) => (refOf(l) && statusOf(l) !== "closed" ? [formatRef(refOf(l)!)] : [])),
  );
  return {
    lanes: lanes.map((lane) => {
      const ref = refOf(lane);
      const seen = ref && listed.get(formatRef(ref));
      let paneState: PaneState = "unassigned";
      if (ref) {
        if (!seen) paneState = "vanished";
        else if (ref.runtime === "headless" && (seen.status === "unknown" || seen.status === "error"))
          paneState = "unverified";
        else paneState = "live";
      }
      return {
        key: lane.key,
        status: statusOf(lane),
        pane: lane.sessionRef?.id ?? null,
        paneState,
      };
    }),
    unregistered: sessions.filter((s) => !registered.has(formatRef(s.ref))).map((s) => s.ref.id),
  };
};
