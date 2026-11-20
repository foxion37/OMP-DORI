import { join } from "node:path";
import { readMonitorManifests, terminalMonitorDirs } from "./boot-monitors.ts";
import { Checkpoints, type Checkpoint } from "./checkpoints.ts";
import { Decisions } from "./decisions.ts";
import { type Decision, settled } from "./decisions-record.ts";
import type { FlowDeps } from "./done-flow.ts";
import { unfinishedOutcome } from "./holds.ts";
import type { PaneState } from "./lane-state.ts";
import { type Lane, LANE_KEY, type LaneStatus, sessionOf, statusOf } from "./registry.ts";
import { type Progress, Reports } from "./reports.ts";
import { runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";
import { readStatusRegistry } from "./status-registry.ts";

export class StatusError extends Error {}

type RuntimeStatus = Pick<PaneState, "agentStatus" | "goal" | "approvalPending" | "updatedAt">;

const GOAL_STATUSES: Readonly<Record<PaneState["goal"]["status"], true>> = {
  none: true,
  active: true,
  paused: true,
  complete: true,
  dropped: true,
  blocked: true,
};

// Session identity does not validate the observation fields in the on-disk pane record.
const projectRuntime = ({ agentStatus, goal, approvalPending, updatedAt }: PaneState): RuntimeStatus | null => {
  if (
    (agentStatus !== undefined && agentStatus !== "idle" && agentStatus !== "working") ||
    !goal ||
    typeof goal !== "object" ||
    Array.isArray(goal) ||
    typeof goal.status !== "string" ||
    !Object.hasOwn(GOAL_STATUSES, goal.status) ||
    (goal.objective !== undefined && typeof goal.objective !== "string") ||
    typeof approvalPending !== "boolean" ||
    typeof updatedAt !== "string" ||
    !Number.isFinite(Date.parse(updatedAt))
  )
    return null;
  const { status, objective } = goal;
  return {
    ...(agentStatus === undefined ? {} : { agentStatus }),
    goal: { status, ...(objective === undefined ? {} : { objective }) },
    approvalPending,
    updatedAt,
  };
};

export type StatusLane = {
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  readonly status: LaneStatus;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly runtime: RuntimeStatus | null;
  readonly progress: Progress | null;
  readonly checkpoint: Checkpoint | null;
  readonly lastSweepNote: string | null;
  readonly lastNudgeAt: number | null;
  readonly lastPostedAt: number | null;
  readonly decisions: number | null;
  readonly errors: readonly string[];
};
export type StatusSnapshot = {
  readonly observedAt: string;
  readonly registryIncomplete: boolean;
  readonly lanes: readonly StatusLane[];
  readonly decisions: number | null;
  readonly monitors: {
    readonly recorded: number | null;
    readonly suspended: number | null;
    readonly expired: number | null;
  };
  readonly errors: readonly string[];
};

/** Only observations: never sweep, observe, run hooks, write a journal, or read a private session transcript. */
export const laneStatus = async (deps: FlowDeps, key?: string): Promise<StatusSnapshot> => {
  if (key !== undefined && !LANE_KEY.test(key)) throw new StatusError("invalid lane key");
  const registry = await readStatusRegistry(deps.registry, key);
  const all = registry.lanes.filter((lane) => key !== undefined || statusOf(lane) !== "closed");
  if (key !== undefined && !all.length && !registry.errors.length) throw new StatusError(`no registered lane ${key}`);
  const now = deps.clock.now();
  const errors = [...registry.errors];
  let open: Decision[] = [];
  let decisionsKnown = true;
  try {
    const decisions = new Decisions(deps.config.stateDir).read();
    decisionsKnown = decisions.problems.length === 0;
    errors.push(...decisions.problems.map(() => "decision journal damaged"));
    open = decisions.items.filter((d) => settled(d) === undefined);
  } catch {
    decisionsKnown = false;
    errors.push("decision journal unreadable");
  }
  const reports = new Reports(deps.config.stateDir);
  const checkpoints = new Checkpoints(deps.config.stateDir);
  const lanes: StatusLane[] = [];
  for (const lane of all.sort((a, b) => a.thread.localeCompare(b.thread) || a.key.localeCompare(b.key))) {
    const problems: string[] = [];
    let progress: Progress | null = null;
    let checkpoint: Checkpoint | null = null;
    let runtime: RuntimeStatus | null = null;
    try {
      progress = reports.read(lane.key, { generation: lane.lifecycleEpoch });
    } catch {
      problems.push("report journal unreadable");
    }
    try {
      checkpoint = checkpoints.read(lane.key).at(-1) ?? null;
    } catch {
      problems.push("checkpoint journal unreadable");
    }
    const ref = sessionOf(lane);
    if (ref && !lane.session && statusOf(lane) !== "closed") problems.push("runtime unbound; run dori sync --write");
    if (ref && lane.session && statusOf(lane) !== "closed") {
      try {
        const state = await trustedPaneState(deps.run, deps.config.stateDir, ref, runtimesOf(deps));
        if (state && lane.session === state.sessionId) {
          runtime = projectRuntime(state);
          if (!runtime) problems.push("runtime observation invalid");
        }
      } catch {
        problems.push("runtime observation unavailable");
      }
    }
    lanes.push({
      key: lane.key,
      title: lane.title,
      thread: lane.thread,
      status: statusOf(lane),
      openedAt: lane.openedAt,
      closedAt: lane.closedAt ?? null,
      runtime,
      progress,
      checkpoint,
      lastSweepNote: lane.lastFreshnessNote ?? null,
      lastNudgeAt: lane.lastNudgeAt ?? null,
      lastPostedAt: lane.lastAutoReplyAt ?? null,
      decisions: decisionsKnown ? open.filter((d) => d.lane === lane.key).length : null,
      errors: problems,
    });
  }
  const { manifests, errors: monitorErrors } = readMonitorManifests(
    deps.config.sessionsDir,
    terminalMonitorDirs(deps.env ?? process.env),
    join(deps.config.stateDir, "monitors"),
  );
  errors.push(...monitorErrors.map(() => "monitor metadata unreadable"));
  const monitors = manifests.flatMap((m) => m.data.monitors);
  // Legacy boot may use command when argv is unusable; status does not certify that metadata as complete.
  const fieldsKnown = monitors.every(
    (m) => m.argv === undefined || (Array.isArray(m.argv) && m.argv.every((arg: unknown) => typeof arg === "string")),
  );
  if (!fieldsKnown) errors.push("monitor argv metadata invalid");
  const monitorsKnown = monitorErrors.length === 0 && fieldsKnown;
  return {
    observedAt: new Date(now).toISOString(),
    registryIncomplete: registry.errors.length > 0,
    lanes,
    decisions: decisionsKnown ? (key === undefined ? open.length : open.filter((d) => d.lane === key).length) : null,
    monitors: {
      recorded: monitorsKnown ? monitors.length : null,
      suspended: monitorsKnown ? monitors.filter((m) => m.suspended === true).length : null,
      expired: monitorsKnown ? monitors.filter((m) => m.expiresAt !== undefined && m.expiresAt <= now).length : null,
    },
    errors,
  };
};

/** Historical elapsed time, not a completion promise. Groups use an explicit key prefix, not inferred dates. */
export const laneEta = (lanes: readonly Lane[], prefix: string) => {
  const minutes = lanes
    .filter((l) => l.key.startsWith(prefix) && l.closedAt && !unfinishedOutcome(l))
    .flatMap((l) => {
      const elapsed = (Date.parse(l.closedAt ?? "") - Date.parse(l.openedAt)) / 60_000;
      return Number.isFinite(elapsed) && elapsed >= 0 ? [elapsed] : [];
    })
    .sort((a, b) => a - b);
  const n = minutes.length;
  return {
    prefix,
    samples: n,
    medianMinutes: n < 3 ? null : ((minutes[Math.floor((n - 1) / 2)] ?? 0) + (minutes[Math.floor(n / 2)] ?? 0)) / 2,
    minMinutes: n < 3 ? null : minutes[0],
    maxMinutes: n < 3 ? null : minutes[n - 1],
  };
};
