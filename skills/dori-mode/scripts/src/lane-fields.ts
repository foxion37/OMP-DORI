/**
 * The lane-record fields dori's own features add on top of the core record: the label it shows (`labels.ts`), where the
 * session was placed (`placement.ts`) and the relay/context handoff state (`relay.ts`, `context.ts`).
 */

export type LaneFields = {
  /** What dori shows for this lane everywhere it names it: `DICO : <title>`, `TLGR : <title>`, or the bare title. */
  readonly label?: string | undefined;
  /** Work stream this lane belongs to (`--group`): a group's lanes share a workspace, splits of one another. */
  readonly group?: string | undefined;
  /** How the session was placed: its own tab, a split below a group mate, or the root of a workspace dori made. */
  readonly placement?: "tab" | "split" | "workspace" | undefined;
  /** The herdr workspace the lane sits in; `workspaceCreated` marks the ones dori made, the only ones it closes. */
  readonly workspace?: string | undefined;
  readonly workspaceCreated?: boolean | undefined;
  /** Completed relays and the sessions they replaced (oldest first), so a successor's history stays with the lane. */
  readonly relays?: number | undefined;
  readonly previousPanes?: readonly string[] | undefined;
  readonly lastRelayAt?: string | undefined;
  /** The context monitor printed CONTEXT_HIGH for the current crossing; cleared when usage falls back under it. */
  readonly contextAlerted?: boolean | undefined;
  /** An automatic relay failed for the current crossing: it is not retried until the crossing resets. */
  readonly relayFailed?: boolean | undefined;
  /** Last RELAY_SKIPPED reason printed by the monitor, so an unchanged reason is not repeated every tick. */
  readonly relaySkipNote?: string | undefined;
  readonly contextUnknownAlerted?: boolean | undefined;
};
