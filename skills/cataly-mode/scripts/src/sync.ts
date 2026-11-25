import { formatRef } from "../../../../src/runtime/types.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { hasTerminalScope, leadAddress } from "./lead-ref.ts";
import { statusOf } from "./registry.ts";
import { iso, type Ran, type Runner, runtimesOf } from "./run.ts";
import { procTable, resolveSession, type SessionHit } from "./session-id.ts";
import { listSessions, listWatched } from "./sessions.ts";

export type SyncRow = {
  readonly key: string;
  readonly thread: string;
  readonly pane: string;
  readonly session: string;
  readonly status: string;
  readonly source: SessionHit["via"] | "registry";
  /** A sampled ID relationship, never a native current-owner guarantee or permission to act. */
  readonly relationship: "matched" | "changed" | "unbound" | "unknown";
  readonly unknownReason: string | null;
};
export type SyncResult = {
  readonly rows: SyncRow[];
  readonly drift: string[];
  readonly unregistered: SyncRow[];
  /** Start of this observation pass; the rows are not an atomic live snapshot. */
  readonly observedAt: string;
};

const observation = (
  hit: SessionHit,
  registered?: string,
): Pick<SyncRow, "source" | "relationship" | "unknownReason"> => ({
  source: hit.id ? hit.via : registered ? "registry" : "none",
  relationship: !hit.id ? "unknown" : !registered ? "unbound" : hit.id === registered ? "matched" : "changed",
  unknownReason: hit.unknownReason ?? null,
});

// Share only successful read-only process-table reads for this pass. Session listings and action checks stay fresh.
const PASS_SHARED = /^ps -A -o pid=,ppid=,command=$/;
const passRunner = (run: Runner): Runner => {
  const seen = new Map<string, Ran>();
  return async (argv, opts) => {
    const key = JSON.stringify(argv);
    if (opts || !PASS_SHARED.test(argv.join(" "))) return run(argv, opts);
    const ran = seen.get(key) ?? (await run(argv));
    if (ran.code === 0) seen.set(key, ran);
    return ran;
  };
};

export const syncRegistry = async (deps: FlowDeps, write: boolean): Promise<SyncResult> => {
  const observedAt = iso(deps.clock);
  const scopedRun = write ? undefined : passRunner(deps.run);
  const lanes = await deps.registry.open();
  const rts = runtimesOf(deps, scopedRun);
  const target = leadAddress(deps.config, deps.env ?? process.env);
  const lead = "ref" in target ? target.ref : undefined;
  const scopes = lead ? [...lanes, { sessionRef: lead }] : lanes;
  const sessions = await listSessions(rts, { lanes: scopes });
  const live = new Map(sessions.map((s) => [formatRef(s.ref), s]));
  const run = scopedRun ?? deps.run;
  const table = hasTerminalScope(rts.choice?.kind, lanes, lead) ? await procTable(run) : null;
  const rows: SyncRow[] = [];
  const drift: string[] = [];
  const resolveDeps = {
    run,
    sessionsDir: deps.config.sessionsDir,
    stateDir: deps.config.stateDir,
    rts,
    now: () => deps.clock.now(),
  };
  for (const lane of lanes) {
    const session = lane.sessionRef ? live.get(formatRef(lane.sessionRef)) : undefined;
    if (!session)
      drift.push(`${lane.key}: pane ${lane.sessionRef?.id ?? "(none)"} is gone but the lane is ${statusOf(lane)}`);
    const hit: SessionHit = session
      ? await resolveSession(session.ref, session.cwd ?? "", table, resolveDeps)
      : { id: "", via: "none", unknownReason: "pane not listed" };
    if (lane.session && hit.id && hit.id !== lane.session)
      drift.push(`${lane.key}: pane now runs session ${hit.id} (registry has ${lane.session})`);
    if (!lane.done) drift.push(`${lane.key}: empty Done line, so a done claim can never close it`);
    if (write && session && session.ref.runtime !== "headless" && hit.id && hit.id !== lane.session) {
      const held = await withDeliveryLock(deps, lane.key, () =>
        deps.registry.update(lane.key, (current) => {
          if (
            !current?.sessionRef ||
            current.openedAt !== lane.openedAt ||
            statusOf(current) === "closed" ||
            current.session !== lane.session ||
            formatRef(current.sessionRef) !== formatRef(session.ref) ||
            current.lifecycleEpoch ||
            current.hold?.outcome
          )
            return null;
          const prior = current.priorSessions === undefined ? [] : current.priorSessions;
          if (!Array.isArray(prior) || prior.some((id) => typeof id !== "string" || !id)) {
            drift.push(`${lane.key}: invalid prior session bindings; registry unchanged`);
            return null;
          }
          return {
            ...current,
            ...(current.session ? { priorSessions: [...new Set([...prior, current.session])] } : {}),
            session: hit.id,
            sessionVia: hit.via,
          };
        }),
      );
      if (!held.ok || !held.value)
        drift.push(`${lane.key}: session drift left unchanged; verify the lane before acting`);
    }
    rows.push({
      key: lane.key,
      thread: lane.thread,
      pane: lane.sessionRef?.id ?? "-",
      session: hit.id ? `${hit.id} (${hit.via})` : (lane.session ?? "-"),
      status: statusOf(lane),
      ...observation(hit, lane.session),
    });
  }
  const owned = new Set(lanes.flatMap((l) => (l.sessionRef ? [formatRef(l.sessionRef)] : [])));
  const skip = new Set(lead ? deps.config.ignorePanes : [deps.config.leadPane, ...deps.config.ignorePanes]);
  const watched = deps.config.workspaces.length > 0 ? await listWatched(rts, deps.config.workspaces, scopes) : sessions;
  const unregistered: SyncRow[] = [];
  for (const s of watched) {
    const id = s.ref.id;
    if (owned.has(formatRef(s.ref)) || skip.has(id) || (lead && formatRef(s.ref) === formatRef(lead))) continue;
    if (s.agent === undefined) continue;
    const hit = await resolveSession(s.ref, s.cwd ?? "", table, resolveDeps);
    unregistered.push({
      key: s.title ?? s.name ?? id,
      thread: "-",
      pane: id,
      session: hit.id ? `${hit.id} (${hit.via})` : "-",
      status: "unregistered",
      ...observation(hit),
    });
  }
  return { rows, drift, unregistered, observedAt };
};
