import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import { shellQuote } from "../src/launch-footer.ts";
import { type Lane, type LaneStatus } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const lane = (key: string, status: LaneStatus = "working", pane = `w1:${key}`): Lane => ({
  key,
  status,
  sessionRef: { runtime: "tern", id: pane },
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
});

/** One OMP desired-monitor manifest owned by session `owner`, watching lane `closed`. */
const metadata = (name: string): string =>
  JSON.stringify({
    version: 1,
    sessionId: "owner",
    monitors: [{ name, argv: ["cataly", "watch", "closed"], cwd: "/repo" }],
  });

let state: ReturnType<typeof withState>;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

const bootDeps = (world: World, slack: () => Promise<{ userId: string; teamId: string } | null> = async () => null) => {
  const sessionsDir = join(state.dir, "sessions");
  const deps = depsFor(world, fakeClock(T0), state.dir, { sessionsDir, leadPane: "tern:5001" });
  return { ...deps, reports: new Reports(state.dir), worklog: new Worklog(state.dir), slack, sessionsDir };
};

test("a manifest with a malformed monitor entry is named as unreadable and the check still finishes", async () => {
  // Given two manifests whose monitors list holds null and a string, and a valid manifest.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("closed", "closed"));
  const dir = join(state.dir, "monitors");
  mkdirSync(dir);
  writeFileSync(join(dir, "null.json"), JSON.stringify({ version: 1, sessionId: "owner", monitors: [null] }));
  writeFileSync(join(dir, "string.json"), JSON.stringify({ version: 1, sessionId: "owner", monitors: ["watch"] }));
  writeFileSync(join(dir, "owner.json"), metadata("good"));
  // When boot runs; then both bad files are named, the good watch is still listed, and the run is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`MONITORS unreadable ${shellQuote(join(dir, "null.json"))}`);
  expect(result.lines).toContain(`MONITORS unreadable ${shellQuote(join(dir, "string.json"))}`);
  expect(result.lines).toContain('STOP in the owner session only: monitor({"op":"stop","name":"good"})');
  expect(result.exitCode).toBe(1);
});

test("one unreadable metadata file is named and the other sessions' cleanup is still listed, path quoted", async () => {
  // Given a corrupt manifest and a valid one whose file name holds a space.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("closed", "closed"));
  const dir = join(state.dir, "monitors");
  mkdirSync(dir);
  writeFileSync(join(dir, "a.json"), "{partial");
  writeFileSync(join(dir, "b session.json"), metadata("good"));
  // When boot runs.
  const result = await bootCheck(deps);
  // Then the bad file is named, the good one still yields its stop call, and its path is shell-quoted.
  expect(result.lines).toContain(`MONITORS unreadable ${shellQuote(join(dir, "a.json"))}`);
  expect(result.lines).toContain(
    `CLEANUP closed match=closed:argv:key ownerSession=owner metadata=${shellQuote(join(dir, "b session.json"))}`,
  );
  expect(result.lines).toContain('STOP in the owner session only: monitor({"op":"stop","name":"good"})');
  expect(result.exitCode).toBe(1);
});

test("boot discovers OMP desired monitor metadata under stateDir without mutating or stopping it", async () => {
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("closed", "closed"));
  const dir = join(state.dir, "monitors");
  mkdirSync(dir);
  const path = join(dir, "omp-owner.json");
  const metadata = JSON.stringify({
    version: 1,
    sessionId: "omp-owner",
    monitors: [{ name: "lane-watch", argv: ["cataly", "watch", "closed"], filter: "LANE", cwd: "/repo" }],
  });
  writeFileSync(path, metadata);
  const result = await bootCheck(deps);
  expect(result.lines).toContain(
    `CLEANUP closed match=closed:argv:key ownerSession=omp-owner metadata=${shellQuote(path)}`,
  );
  expect(result.lines).toContain('STOP in the owner session only: monitor({"op":"stop","name":"lane-watch"})');
  expect(await Bun.file(path).text()).toBe(metadata);
  expect(world.calls.some((argv) => argv.includes("stop"))).toBe(false);
});
