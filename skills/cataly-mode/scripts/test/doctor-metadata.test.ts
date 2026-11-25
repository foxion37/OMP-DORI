import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorCheck } from "../src/doctor.ts";
import { Reports } from "../src/reports.ts";
import { depsFor, fakeClock, nativeLead, newWorld, withState, type TestState } from "./fakes.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const now = Date.parse("2026-01-01T12:00:00Z");

test.each([
  { name: "working lead", status: "working", held: false, expected: "working", expectedApproval: "false" },
  { name: "idle lead with an open approval", status: "idle", held: true, expected: "idle", expectedApproval: "true" },
  { name: "blocked lead", status: "blocked", held: true, expected: "unknown", expectedApproval: "true" },
  { name: "unattested lead", status: "unknown", held: false, expected: "unknown", expectedApproval: undefined },
] as const)("doctor reports only attested lead metadata: $name", async (scenario) => {
  const { status, held, expected, expectedApproval } = scenario;
  const world = newWorld();
  const pane = nativeLead(world, 1, { status, held });
  const deps = depsFor(world, fakeClock(now), state.dir, { leadPane: pane, sessionsDir: join(state.dir, "sessions") });
  const result = await doctorCheck(deps);
  expect(result.findings.filter((finding) => finding.check === "runtime")).toEqual([
    {
      check: "runtime",
      severity: expectedApproval === undefined ? "WARN" : "OK",
      detail:
        expectedApproval === undefined
          ? `headless lead="${pane}" has no trusted live Cataly record`
          : `headless lead="${pane}" role=cataly status=${expected} approvalPending=${expectedApproval}`,
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
        detail: "not supervised (adopted lanes): adopted; configured ceilings do not apply",
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
