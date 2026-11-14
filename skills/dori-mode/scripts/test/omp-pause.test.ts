import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { freshnessTick } from "../src/freshness.ts";
import { paneStatePath, readPaneState } from "../src/lane-state.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { agentIn, depsFor, fakeClock, hcSent, laneState, newWorld, sent, withState, type World } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: { dir: string; done: () => void };
let world: World;
const working: Lane = {
  key: "waiting-lane",
  title: "wait",
  thread: "none",
  pane: "w:p7",
  brief: "/b.md",
  done: "closed acme/app#1",
  cwd: "/repo",
  openedAt: new Date(T0).toISOString(),
  lastReplyAt: T0,
};
const deps = (ms = T0) => depsFor(world, fakeClock(ms), state.dir);
const escapes = () => world.calls.filter((c) => c[2] === "send-keys" && c[4] === "escape");

beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "idle" }];
  agentIn(world, "w:p7");
  laneState(state.dir, "w:p7");
  world.onSendText = (id, text) => {
    const goal = readPaneState(state.dir, id)?.goal.status;
    if (text === "/goal pause" && goal === "active") laneState(state.dir, id, { goal: { status: "paused" } });
    if (text === "/goal resume" && goal === "paused") laneState(state.dir, id, { goal: { status: "active" } });
  };
  await deps().registry.write(working);
});
afterEach(() => state.done());

test("OMP pause confirms native goal state before Escape and resume restores the earlier status and quiet clock", async () => {
  const lane: Lane = { ...working, status: "not-done" };
  await deps().registry.write(lane);
  if (world.panes[0]) world.panes[0].agent_status = "working";
  const paused = await pauseLane(deps(T0 + MIN), lane, "owner said wait");
  expect(paused.code).toBe(0);
  expect(statusOf(paused.lane)).toBe("paused");
  expect(readPaneState(state.dir, "w:p7")?.goal.status).toBe("paused");
  expect(escapes()).toHaveLength(1);
  expect(world.calls.findIndex((c) => c[2] === "send-text")).toBeLessThan(
    world.calls.findIndex((c) => c[2] === "send-keys" && c[4] === "escape"),
  );
  expect(await freshnessTick(deps(T0 + 60 * MIN), "/home/test")).toEqual([]);
  const resumed = await resumeLane(deps(T0 + 90 * MIN), paused.lane, "owner said go");
  expect(resumed.code).toBe(0);
  expect(statusOf(resumed.lane)).toBe("not-done");
  expect(resumed.lane.lastReplyAt).toBe(T0 + 90 * MIN);
  expect(readPaneState(state.dir, "w:p7")?.goal.status).toBe("active");
  expect(sent(world)).toEqual(["/goal pause", "/goal resume"]);
  expect(await freshnessTick(deps(T0 + 95 * MIN), "/home/test")).toEqual([]);
});

test("OMP's ambiguous no-active-goal line never proves an active goal paused, and a paused goal never proves resume", async () => {
  delete world.onSendText;
  world.screens = ["prompt", "No active goal to pause.\nGoal paused\n"];
  expect((await pauseLane(deps(), working, "wait")).code).toBe(3);
  expect(statusOf((await deps().registry.read(working.key)) ?? working)).toBe("working");
  expect(escapes()).toEqual([]);
  laneState(state.dir, "w:p7", { goal: { status: "paused" } });
  const paused: Lane = { ...working, status: "paused" };
  await deps().registry.write(paused);
  world.screen = "No paused goal to resume.\nGoal active\n";
  expect((await resumeLane(deps(), paused, "go")).code).toBe(3);
  expect(statusOf((await deps().registry.read(working.key)) ?? working)).toBe("paused");
});

test("missing, stale or foreign session records stay unverified, and an approval hold receives no input", async () => {
  delete world.onSendText;
  for (const pid of [77, 88]) {
    laneState(state.dir, "w:p7", { pid, goal: { status: "paused" } });
    if (pid === 88) world.procs?.push({ pid, ppid: 1, cmd: "omp --dori-role lane" });
    expect((await pauseLane(deps(), working, "wait")).code).toBe(3);
  }
  writeFileSync(paneStatePath(state.dir, "w:p7"), "{partial");
  expect((await pauseLane(deps(), working, "wait")).code).toBe(3);
  laneState(state.dir, "w:p7", { approvalPending: true });
  const before = sent(world).length;
  expect((await pauseLane(deps(), working, "wait")).code).toBe(3);
  expect(sent(world).length).toBe(before);
  expect(escapes()).toEqual([]);
  expect(statusOf((await deps().registry.read(working.key)) ?? working)).toBe("working");
});

test("an explicit none goal is quiescent, while unknown and budget-limited statuses never become none", async () => {
  delete world.onSendText;
  for (const status of ["blocked", "budget-limited", "unknown"]) {
    const record = readPaneState(state.dir, "w:p7");
    writeFileSync(paneStatePath(state.dir, "w:p7"), JSON.stringify({ ...record, goal: { status } }));
    expect((await pauseLane(deps(), working, "wait")).code).toBe(3);
    expect(statusOf((await deps().registry.read(working.key)) ?? working)).toBe("working");
  }
  laneState(state.dir, "w:p7", { goal: { status: "none" } });
  expect((await pauseLane(deps(), working, "wait")).code).toBe(0);
  expect(escapes()).toEqual([]);
});

test("complete or dropped goals need a fresh corroborating OMP response", async () => {
  delete world.onSendText;
  laneState(state.dir, "w:p7", { goal: { status: "complete" } });
  expect((await pauseLane(deps(), working, "wait")).code).toBe(3);
  world.screens = ["prompt", "No active goal to pause.\n"];
  const paused = await pauseLane(deps(), working, "wait");
  expect(paused.code).toBe(0);
  laneState(state.dir, "w:p7", { goal: { status: "dropped" } });
  world.screens = ["prompt", "No paused goal to resume.\n"];
  expect((await resumeLane(deps(), paused.lane, "go")).code).toBe(0);
});

test("native OMP pause and resume also read back an hc terminal's direct-program session", async () => {
  world.terminals = {
    t1: hcTerm({
      pid: 4242,
      status: { state: "idle", app: "omp" },
      foreground: { name: "omp", argv: ["omp"], pid: 4242 },
    }),
  };
  world.procs = [{ pid: 4242, ppid: 1, cmd: "omp --dori-role lane" }];
  laneState(state.dir, "t1");
  const lane: Lane = { ...working, pane: "t1", sessionRef: { runtime: "hc", id: "t1" } };
  const d = depsFor(world, fakeClock(T0), state.dir, { runtime: "hc" });
  await d.registry.write(lane);
  const paused = await pauseLane(d, lane, "wait");
  expect(paused.code).toBe(0);
  expect((await resumeLane(d, paused.lane, "go")).code).toBe(0);
  expect(hcSent(world)).toEqual(["/goal pause", "/goal resume"]);
});
