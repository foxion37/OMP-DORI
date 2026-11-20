import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import type { Manifest } from "../src/boot-monitors.ts";
import type { DoriConfig } from "../src/config.ts";
import { doctorCheck } from "../src/doctor.ts";
import { monitorFilterFindings } from "../src/doctor-monitors.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState } from "./fakes.ts";

const manifest = (command: string, filter: string, name = "custom-name"): Manifest => ({
  kind: "omp",
  path: "/fixture",
  data: {
    version: 1,
    sessionId: "owner",
    monitors: [{ name, argv: ["dori", command], filter, cwd: "/work" }],
  },
});

test("guard and watch diagnostics probe actual state-change events", () => {
  const guard = monitorFilterFindings([manifest("guard", "^(HOST_GUARD_|WARN)")], "owner");
  expect(guard[0]?.severity).toBe("WARN");
  expect(guard[0]?.detail).toContain("HOST_GUARD ALERT");
  expect(guard[0]?.detail).toContain("HOST_GUARD CLEAR");
  expect(guard[0]?.detail).toContain("HOST_GUARD COMPUTE_BUSY");
  const watch = monitorFilterFindings([manifest("watch", "^LANE_(WATCH|DONE)")], "owner");
  for (const event of ["LANE_CHANGED", "LANE_NOT_DONE", "LANE_CLOSED", "LANE_HELD"])
    expect(watch[0]?.detail).toContain(event);
  expect(monitorFilterFindings([manifest("watch", "^LANE_")], "owner")).toEqual([]);
});

const watchFilterBeforeQueue = "^LANE_(?:WATCH_READY$|(?:WATCH_WARN|DONE_CLAIMED|CHANGED|NOT_DONE|CLOSED|HELD) \\S)";

test("doctor warns when a previously complete watch filter drops all three queue events", () => {
  expect(monitorFilterFindings([manifest("watch", watchFilterBeforeQueue)], "owner")).toEqual([
    {
      check: "monitor-filter",
      severity: "WARN",
      detail:
        '"custom-name" misses probes: LANE_QUEUE_READY LANE_QUEUE_HELD LANE_QUEUE_WARN; inspect dori monitor-presets watch in the owner session',
    },
  ]);
});

test("doctor accepts bare readiness lines and payload-bearing monitor events", async () => {
  const state = withState();
  try {
    const pane = "w1:p1";
    const world = newWorld();
    world.panes = [{ pane_id: pane, workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
    agentIn(world, pane);
    laneState(state.dir, pane, { role: "dori", sessionId: "owner", agentStatus: "idle" });
    const deps = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00Z")), state.dir, {
      leadPane: pane,
      sessionsDir: join(state.dir, "sessions"),
      doctor: { ignore: ["monitor-runtime"] },
    });
    const watch = manifest(
      "watch",
      `${watchFilterBeforeQueue}|^LANE_QUEUE_(?:READY \\S+; live checks |HELD \\S+ \\S+\\(working\\)$|WARN \\S+\\.json: invalid queue record: \\S+$)`,
    );
    const guard = manifest(
      "guard",
      "^(?:HOST_GUARD_READY$|HOST_GUARD (?:ALERT \\S|(?:CLEAR|COMPUTE_READY|COMPUTE_BUSY) load \\d)|WARN \\S)",
      "guard",
    );
    const monitors = [...watch.data.monitors, ...guard.data.monitors];
    const dir = join(state.dir, "monitors");
    mkdirSync(dir);
    writeFileSync(join(dir, "owner.json"), JSON.stringify({ ...watch.data, monitors }));

    const result = await doctorCheck(deps);
    expect(result.findings.filter((finding) => finding.check === "monitor-filter")).toEqual([]);
    expect(result.exitCode).toBe(0);

    const readinessOnly = monitorFilterFindings([manifest("watch", "^LANE_WATCH_READY$")], "owner");
    expect(readinessOnly[0]?.severity).toBe("WARN");
    expect(readinessOnly[0]?.detail).toContain("LANE_WATCH_WARN");
    expect(readinessOnly[0]?.detail).not.toContain("LANE_WATCH_READY");
  } finally {
    state.done();
  }
});

const defaultFreshnessFilter =
  "^(?:(?:BLOCKED|WARNING) \\S+ (?:wallMinutes|tokens|costUsd) ceiling (?:reached \\(\\d+\\)|cannot be checked: usage unavailable)$|(?:NUDGED|POSTED|POST-FAILED|NO-REPORT|PENDING-REPORT|STALE-REPORT|STALLED|JOURNAL-ERROR|WORKING-WHILE-PAUSED|SUPERVISION-ERROR|WARN)\\b)";

const freshnessFilterCases: ReadonlyArray<{
  readonly name: string;
  readonly config: Pick<DoriConfig, "freshness">;
  readonly missing: readonly string[];
}> = [
  { name: "default config", config: {}, missing: [] },
  { name: "explicit unrestricted settings", config: { freshness: { nudge: "all", postRaw: true } }, missing: [] },
  { name: "idle-only nudge", config: { freshness: { nudge: "idle-only" } }, missing: ["NUDGE-FAILED"] },
  { name: "raw posting disabled", config: { freshness: { postRaw: false } }, missing: ["UNRELAYED"] },
  { name: "empty auto-post allowlist", config: { freshness: { autoPostKinds: [] } }, missing: ["UNRELAYED"] },
  {
    name: "both restrictions",
    config: { freshness: { nudge: "idle-only", postRaw: false } },
    missing: ["NUDGE-FAILED", "UNRELAYED"],
  },
];

test.each(freshnessFilterCases)(
  "doctor checks the default freshness filter with $name",
  async ({ config, missing }) => {
    const state = withState();
    try {
      const pane = "w1:p1";
      const world = newWorld();
      world.panes = [{ pane_id: pane, workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
      agentIn(world, pane);
      laneState(state.dir, pane, { role: "dori", sessionId: "owner", agentStatus: "idle" });
      const deps = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00Z")), state.dir, {
        leadPane: pane,
        sessionsDir: join(state.dir, "sessions"),
        doctor: { ignore: ["monitor-runtime"] },
        ...config,
      });
      const dir = join(state.dir, "monitors");
      mkdirSync(dir);
      writeFileSync(
        join(dir, "owner.json"),
        JSON.stringify(manifest("freshness", defaultFreshnessFilter, "freshness").data),
      );

      const result = await doctorCheck(deps);
      expect(result.findings.filter((finding) => finding.check === "monitor-filter")).toEqual(
        missing.length
          ? [
              {
                check: "monitor-filter",
                severity: "WARN",
                detail: `"freshness" misses probes: ${missing.join(" ")}; inspect dori monitor-presets freshness in the owner session`,
              },
            ]
          : [],
      );
      expect(result.exitCode).toBe(missing.length ? 1 : 0);
    } finally {
      state.done();
    }
  },
);

test.each([
  {
    name: "freshness",
    argv: ["dori", "freshness"],
    filter: defaultFreshnessFilter,
    omitted: "BLOCKED",
  },
  {
    name: "pr-watch",
    argv: ["dori", "pr", "watch"],
    filter:
      "^(?:PR_MERGED \\S+#\\d+ lane=\\S+ thread=\\S+ sha=(?:[a-f0-9]{40}|unknown)$|PR_(?:FEEDBACK|CI_FAIL|HEAD_MOVED|CLOSED|REOPENED|WATCH_WARN)\\b|WARN\\b)",
    omitted: "PR_MERGED",
  },
])("doctor checks real $name payload shapes", ({ name, argv, filter, omitted }) => {
  const base = manifest(name, filter);
  const check = (pattern: string) =>
    monitorFilterFindings(
      [{ ...base, data: { ...base.data, monitors: [{ name, argv, cwd: "/work", filter: pattern }] } }],
      "owner",
    );
  expect(check(filter)).toEqual([]);
  expect(check(`^(?!${omitted}\\b)`)).toEqual([
    {
      check: "monitor-filter",
      severity: "WARN",
      detail: `"${name}" misses probes: ${omitted}; inspect dori monitor-presets ${name} in the owner session`,
    },
  ]);
});

test("old session filters stay advisory while the trusted current owner's filter warns", async () => {
  const state = withState();
  try {
    const world = newWorld();
    world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
    agentIn(world, "w1:p1");
    laneState(state.dir, "w1:p1", { role: "dori", sessionId: "owner", agentStatus: "idle" });
    const deps = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00Z")), state.dir, {
      leadPane: "w1:p1",
      sessionsDir: join(state.dir, "sessions"),
    });
    const dir = join(state.dir, "monitors");
    mkdirSync(dir);
    const data = manifest("guard", "^HOST_GUARD_").data;
    writeFileSync(join(dir, "old.json"), JSON.stringify({ ...data, sessionId: "old-owner" }));
    const historical = await doctorCheck(deps);
    expect(historical.exitCode).toBe(0);
    expect(historical.findings.filter((finding) => finding.check === "monitor-filter")).toMatchObject([
      { severity: "INFO" },
    ]);
    writeFileSync(join(dir, "owner.json"), JSON.stringify(data));
    const current = await doctorCheck(deps);
    expect(current.exitCode).toBe(1);
    expect(
      current.findings
        .filter((finding) => finding.check === "monitor-filter")
        .map((finding) => finding.severity)
        .sort(),
    ).toEqual(["INFO", "WARN"]);
  } finally {
    state.done();
  }
});

test("done journals do not imply missing adoption and boot names its ignored checks", async () => {
  const state = withState();
  try {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const deps = depsFor(newWorld(), fakeClock(now), state.dir, {
      leadPane: "",
      sessionsDir: join(state.dir, "sessions"),
      doctor: { ignore: ["runtime", "lessons"] },
    });
    await deps.registry.write({
      key: "complete",
      title: "complete",
      brief: "/brief",
      thread: "none",
      done: "file /done",
      openedAt: new Date(now).toISOString(),
      reportProtocol: "jsonl-v1",
    });
    const reports = new Reports(state.dir);
    reports.report("complete", "done", "local output complete", now);
    const result = await doctorCheck(deps);
    expect(result.findings.some((finding) => ["supervision", "worklog"].includes(finding.check))).toBe(false);
    expect(result.exitCode).toBe(0);
    const boot = await bootCheck({ ...deps, reports, worklog: new Worklog(state.dir), slack: async () => null });
    expect(boot.lines).toContain(
      "DOCTOR warn=0 ignored=runtime,lessons (local advisory checks; run dori doctor for details)",
    );
  } finally {
    state.done();
  }
});
