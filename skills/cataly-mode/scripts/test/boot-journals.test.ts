import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import {
  depsFor,
  fakeClock,
  nativeLane,
  nativeLead,
  newWorld,
  sid,
  type TestState,
  withState,
  type World,
} from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

/** A working lane on live native session `sid(n)` of `world`. */
const lane = (world: World, key: string, n: number): Lane => ({
  key,
  status: "working",
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
  ...nativeLane(world, n, { status: "working" }),
});

const launched = (world: World, key: string, n: number): Lane => ({
  ...lane(world, key, n),
  reportProtocol: "jsonl-v1",
});

let state: TestState;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

/** Boot deps over `world`, whose live native lead is session 1. */
const bootDeps = (world: World) => {
  const deps = depsFor(world, fakeClock(T0), state.dir, {
    sessionsDir: join(state.dir, "sessions"),
    leadPane: nativeLead(world, 1),
  });
  return { ...deps, reports: new Reports(state.dir), worklog: new Worklog(state.dir), slack: async () => null };
};

test("a corrupt journal is reported for its lane and does not stop the check", async () => {
  // Given a lane whose journal ends in a partial write.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched(world, "broken", 2));
  await deps.reports.report("broken", "milestone", "started", T0);
  writeFileSync(deps.reports.path("broken"), `${readFileSync(deps.reports.path("broken"), "utf8")}{partial\n`);
  // When boot runs; then the lane is named with the error kind and no local path, the rest still runs, and the exit is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("JOURNAL-ERROR broken kind=invalid-journal");
  expect(result.lines.join("\n")).not.toContain(state.dir);
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("the launch's activity record is not a report: a lane that never reported reads NO-REPORT", async () => {
  // Given a launched lane whose journal holds only the harness's launch activity.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched(world, "quiet", 2));
  await deps.reports.append({
    type: "activity",
    key: "quiet",
    at: new Date(T0).toISOString(),
    state: "running",
    text: `lane launched in headless:${sid(2)}`,
  });
  // When boot runs; then the lane is listed as having no report, never with a REPORT line.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(
    "NO-REPORT quiet state=running registryStatus=working (journal holds harness activity only)",
  );
  expect(result.lines.some((l) => l.startsWith("REPORT quiet"))).toBe(false);
});

test("a launched lane with no journal at all reads NO-REPORT, never nothing", async () => {
  // Given a launched lane, on a live native session, that has not written reports.jsonl yet.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched(world, "silent", 2));
  // When boot runs; then the lane is listed as having no journal, and that alone is not a failure.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("NO-REPORT silent registryStatus=working (no journal)");
  expect(result.exitCode).toBe(0);
});

test("a lane without the report protocol has its journal ignored, so a done record there cannot offer its watch for cleanup", async () => {
  // Given a lane registered without reportProtocol, a done record and a persistent watch naming it.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane(world, "adopted", 2));
  await deps.reports.report("adopted", "done", "finished", T0);
  mkdirSync(join(state.dir, "monitors"));
  writeFileSync(
    join(state.dir, "monitors", "owner.json"),
    JSON.stringify({
      version: 1,
      sessionId: "owner",
      monitors: [{ name: "adopted-watch", argv: ["cataly", "watch", "adopted"], cwd: "/repo" }],
    }),
  );
  // When boot runs; then the journal is ignored like freshness ignores it, and the watch is kept.
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => /^(NO-)?REPORT adopted/.test(l))).toBe(false);
  expect(result.lines).toContain("MONITORS cleanupCandidates=0 (from metadata; liveness unverified)");
  expect(result.exitCode).toBe(0);
});

test("an unreadable journal of any kind is that lane's error; the other lanes are still reported", async () => {
  // Given one lane whose journal path is a directory (not a ReportError) and one healthy lane.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched(world, "a-broken", 2));
  await deps.registry.write(launched(world, "b-healthy", 3));
  mkdirSync(deps.reports.path("a-broken"), { recursive: true });
  await deps.reports.report("b-healthy", "blocker", "needs the owner", T0);
  // When boot runs; then both lanes are listed and the run finishes incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("JOURNAL-ERROR a-broken kind=EISDIR");
  expect(result.lines.join("\n")).not.toContain(state.dir);
  expect(result.lines).toContain(
    "REPORT b-healthy kind=blocker at=2026-01-01T12:00:00.000Z state=blocked registryStatus=working",
  );
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});
