import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorCheck } from "../src/doctor.ts";
import { paneStatePath, readPaneState } from "../src/lane-state.ts";
import { Reports } from "../src/reports.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState, type TestState } from "./fakes.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const now = Date.parse("2026-01-01T12:00:00Z");

test.each([
  {
    name: "multiline status",
    stored: "working\nWARN forged lead status",
    expected: "unknown",
    approval: true,
    expectedApproval: "true",
  },
  { name: "unsupported status", stored: "paused", expected: "unknown", approval: true, expectedApproval: "true" },
  { name: "supported status", stored: "working", expected: "working", approval: false, expectedApproval: "false" },
  {
    name: "invalid approval",
    stored: "idle",
    expected: "idle",
    approval: "true\nWARN forged approval",
    expectedApproval: undefined,
  },
])("doctor reports only admitted lead metadata: $name", async (scenario) => {
  const { stored, expected, approval, expectedApproval } = scenario;
  const world = newWorld();
  const pane = "w1:p1";
  world.panes = [{ pane_id: pane, workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
  agentIn(world, pane);
  const deps = depsFor(world, fakeClock(now), state.dir, { leadPane: pane, sessionsDir: join(state.dir, "sessions") });
  laneState(state.dir, pane, { role: "dori" });
  writeFileSync(
    paneStatePath(state.dir, pane),
    JSON.stringify({ ...readPaneState(state.dir, pane), agentStatus: stored, approvalPending: approval }),
  );
  const result = await doctorCheck(deps);
  expect(result.findings.filter((finding) => finding.check === "runtime")).toEqual([
    {
      check: "runtime",
      severity: expectedApproval === undefined ? "WARN" : "OK",
      detail:
        expectedApproval === undefined
          ? `herdr lead="${pane}" has no trusted live Dori record`
          : `herdr lead="${pane}" role=dori status=${expected} approvalPending=${expectedApproval}`,
    },
  ]);
});

test("doctor skips malformed stored lane keys before reporting supervision or reading journals", async () => {
  const deps = depsFor(newWorld(), fakeClock(now), state.dir, {
    leadPane: "",
    sessionsDir: join(state.dir, "sessions"),
  });
  const { config } = deps;
  const registryDir = join(state.dir, "lanes");
  mkdirSync(registryDir);
  const record = {
    title: "lane",
    brief: "/brief",
    done: 'command ["true"]',
    thread: "none",
    openedAt: new Date(now).toISOString(),
  };
  // Windows forbids LF in filenames but permits the Unicode line separator.
  const separator = process.platform === "win32" ? "\u2028" : "\n";
  const malformedLaunched = `bad-launched${separator}WARN forged journal status`;
  const malformedAdopted = `bad-adopted${separator}WARN forged adopted status`;
  for (const [file, key, reportProtocol] of [
    ["launched", "launched", "jsonl-v1"],
    ["adopted", "adopted", undefined],
    [malformedLaunched, malformedLaunched, "jsonl-v1"],
    [malformedAdopted, malformedAdopted, undefined],
    ["different-file", "different-key", "jsonl-v1"],
  ]) {
    writeFileSync(join(registryDir, `${file}.json`), JSON.stringify({ ...record, key, reportProtocol }));
  }
  const readJournal = spyOn(Reports.prototype, "read");
  try {
    const result = await doctorCheck({
      ...deps,
      config: { ...config, supervision: { defaults: {}, usageArgv: ["fixture-usage-must-not-run"] } },
    });
    expect(result.findings.filter((finding) => finding.check === "supervision")).toEqual([
      {
        check: "supervision",
        severity: "INFO",
        detail: "not supervised (adopted/legacy lanes): adopted; configured ceilings do not apply",
      },
      { check: "supervision", severity: "WARN", detail: "no configured ceilings for active lanes: launched" },
    ]);
    expect(result.findings.filter((finding) => finding.check === "registry")).toEqual([
      { check: "registry", severity: "WARN", detail: "lanes=2 unreadable=1 invalidKeys=2" },
    ]);
    expect(result.findings.map((finding) => finding.detail).join("\n")).not.toContain("forged");
    expect(readJournal.mock.calls).toEqual([["launched", { generation: undefined }]]);
  } finally {
    readJournal.mockRestore();
  }
});
