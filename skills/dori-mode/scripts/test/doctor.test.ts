import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import type { Manifest } from "../src/boot-monitors.ts";
import { loadConfig } from "../src/config.ts";
import { doctorCheck } from "../src/doctor.ts";
import { monitorFilterFindings } from "../src/doctor-monitors.ts";
import { monitorPresetFor, monitorPresets } from "../src/monitor-presets.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState, type TestState } from "./fakes.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const now = Date.parse("2026-01-01T12:00:00Z");
const snapshot = (path: string) =>
  readdirSync(path, { recursive: true, withFileTypes: true })
    .map((entry) => [
      join(entry.parentPath, entry.name),
      entry.isFile() ? readFileSync(join(entry.parentPath, entry.name), "utf8") : "directory",
    ])
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
const desired = (filter: string): Manifest => ({
  path: "/unused.json",
  kind: "omp",
  data: {
    version: 1,
    sessionId: "owner",
    monitors: [
      { name: "renamed-sweep", argv: ["/side/bin/omp-dori", "freshness", "--loop", "5"], cwd: "/work", filter },
    ],
  },
});

test("doctor diagnoses configuration and missing filter outcomes without modifying state or calling hooks", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(now), state.dir, { sessionsDir: join(state.dir, "sessions"), leadPane: "" });
  await deps.registry.write({
    key: "demo",
    title: "demo",
    brief: "/brief",
    done: "merged Acme/App#1",
    reportProtocol: "jsonl-v1",
    thread: "none",
    openedAt: new Date(now).toISOString(),
  });
  mkdirSync(join(state.dir, "monitors"));
  writeFileSync(join(state.dir, "monitors", "owner.json"), JSON.stringify(desired("^(NUDGED|POSTED)").data));
  const before = snapshot(state.dir);
  const result = await doctorCheck(deps);
  expect(result.exitCode).toBe(1);
  expect(result.findings).toContainEqual(
    expect.objectContaining({
      check: "repo-identities",
      severity: "WARN",
      detail: expect.stringContaining("acme/app"),
    }),
  );
  expect(result.findings).toContainEqual(
    expect.objectContaining({ check: "monitor-filter", detail: expect.stringContaining("SUPERVISION-ERROR") }),
  );
  expect(result.findings).toContainEqual(
    expect.objectContaining({ check: "supervision", detail: expect.stringContaining("unknown, not zero") }),
  );
  expect(result.findings).toContainEqual(expect.objectContaining({ check: "worklog", severity: "INFO" }));
  expect(result.findings).toContainEqual(expect.objectContaining({ check: "lessons", severity: "INFO" }));
  expect(result.findings).toContainEqual(
    expect.objectContaining({
      check: "monitor-runtime",
      severity: "INFO",
      detail: expect.stringContaining("liveness unverified"),
    }),
  );
  expect(snapshot(state.dir)).toEqual(before);
  expect(world.calls).toEqual([]);
});

test("trusted live lead is distinguished from stale metadata and lane roles", async () => {
  const world = newWorld();
  const pane = "w1:p1";
  world.panes = [{ pane_id: pane, workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
  agentIn(world, pane);
  const deps = depsFor(world, fakeClock(now), state.dir, { leadPane: pane, sessionsDir: join(state.dir, "sessions") });
  laneState(state.dir, pane, { role: "dori", agentStatus: "idle" });
  const result = await doctorCheck(deps);
  expect(result.exitCode).toBe(0);
  expect(result.findings).toContainEqual(
    expect.objectContaining({
      check: "runtime",
      severity: "OK",
      detail: expect.stringContaining("role=dori status=idle"),
    }),
  );
  laneState(state.dir, pane, { role: "lane" });
  expect((await doctorCheck(deps)).findings).toContainEqual(
    expect.objectContaining({ check: "runtime", severity: "WARN" }),
  );
  laneState(state.dir, pane, { role: "dori", pid: 9876 });
  expect((await doctorCheck(deps)).findings).toContainEqual(
    expect.objectContaining({ check: "runtime", severity: "WARN" }),
  );
  expect(
    world.calls.every(
      (argv) => argv[0] === "ps" || (argv[0] === "herdr" && ["get", "process-info"].includes(argv[2] ?? "")),
    ),
  ).toBe(true);
});

test("damaged metadata and incomplete lane signals remain visible; ignore is explicit and reported", async () => {
  mkdirSync(join(state.dir, "lanes"));
  mkdirSync(join(state.dir, "monitors"));
  writeFileSync(join(state.dir, "lanes", "broken.json"), "{");
  writeFileSync(join(state.dir, "lanes", "partial.json"), JSON.stringify({ key: "partial" }));
  writeFileSync(join(state.dir, "monitors", "broken.json"), "{}");
  writeFileSync(join(state.dir, "worklog.jsonl"), "damaged-record\n");
  writeFileSync(join(state.dir, "lessons.jsonl"), "damaged-record\n");
  const deps = depsFor(newWorld(), fakeClock(now), state.dir, {
    leadPane: "",
    sessionsDir: join(state.dir, "sessions"),
    doctor: { ignore: ["runtime", "supervision"] },
  });
  const result = await doctorCheck(deps);
  for (const check of ["registry", "monitors", "worklog", "lessons"])
    expect(result.findings).toContainEqual(expect.objectContaining({ check, severity: "WARN" }));
  expect(result.findings.some((finding) => ["runtime", "supervision"].includes(finding.check))).toBe(false);
  expect(result.ignored).toEqual(["runtime", "supervision"]);
});

test("presets cover all diagnostic probes, match renamed direct commands, and agree with the setup table", () => {
  const docs = readFileSync(join(import.meta.dir, "../../references/setup.md"), "utf8").replaceAll("\\|", "|");
  for (const preset of monitorPresets) {
    expect(preset.events.every((event) => new RegExp(preset.filter).test(`${event} diagnostic detail`))).toBe(true);
    expect(docs).toContain(`\`${preset.filter}\``);
    expect(monitorPresetFor(preset.argv)?.name).toBe(preset.name);
  }
  const freshness = monitorPresets.find((preset) => preset.name === "freshness")!;
  expect(monitorFilterFindings([desired(freshness.filter)])).toEqual([]);
  expect(monitorFilterFindings([desired(freshness.filter)], "owner", { nudge: "idle-only", postRaw: false })).toEqual(
    [],
  );
  expect(monitorFilterFindings([desired("[")])[0]?.detail).toContain("invalid regular expression");
  expect(monitorPresetFor(["bun", "/checkout/skills/dori-mode/scripts/src/cli.ts", "freshness"])?.name).toBe(
    "freshness",
  );
  expect(monitorPresetFor(["bash", "-c", "dori freshness"])).toBeUndefined();
  expect(monitorPresetFor(["cat", "freshness"])).toBeUndefined();
});

test("boot adds an advisory local summary without changing its exit policy or writing state", async () => {
  const deps = depsFor(newWorld(), fakeClock(now), state.dir, { sessionsDir: join(state.dir, "sessions") });
  mkdirSync(join(state.dir, "monitors"));
  writeFileSync(join(state.dir, "monitors", "owner.json"), JSON.stringify(desired("^NUDGED").data));
  const before = snapshot(state.dir);
  const result = await bootCheck({
    ...deps,
    reports: new Reports(state.dir),
    worklog: new Worklog(state.dir),
    slack: async () => null,
  });
  expect(result.lines).toContain("DOCTOR warn=0 ignored=none (local advisory checks; run dori doctor for details)");
  expect(result.exitCode).toBe(0);
  expect(snapshot(state.dir)).toEqual(before);
});

test("doctor uses canonical Done signals, not repository-looking command arguments", async () => {
  const deps = depsFor(newWorld(), fakeClock(now), state.dir, {
    leadPane: "",
    sessionsDir: join(state.dir, "sessions"),
  });
  await deps.registry.write({
    key: "formats",
    title: "formats",
    brief: "/brief",
    thread: "none",
    openedAt: new Date(now).toISOString(),
    done: 'Done = MERGED   Acme/App/pull/123; Closed   Other/Lib/issues/4; command ["echo","merged fake/repo#2"]',
  });
  const report = await doctorCheck(deps);
  expect(
    report.findings.filter((finding) => finding.check === "repo-identities").map((finding) => finding.detail),
  ).toEqual([
    "acme/app is not configured; verify-pr requires its author/committer identity",
    "other/lib is not configured; verify-pr requires its author/committer identity",
  ]);
});

test("doctor config rejects invalid ignore arrays without changing other settings", async () => {
  const path = join(state.dir, "config.json");
  for (const doctor of [
    null,
    [],
    "all",
    { ignore: true },
    { ignore: [1] },
    { ignore: ["unknown-check"] },
    { ignore: [""] },
    { ignores: [] },
  ]) {
    writeFileSync(path, JSON.stringify({ doctor }));
    await expect(loadConfig(path, state.dir)).rejects.toThrow("invalid doctor");
  }
  writeFileSync(
    path,
    JSON.stringify({
      doctor: { ignore: ["lessons"] },
      repoIdentities: { "acme/app": { name: "Demo", email: "demo@example.com" } },
    }),
  );
  expect((await loadConfig(path, state.dir)).doctor).toEqual({ ignore: ["lessons"] });
});
