import { afterEach, beforeEach, expect, test } from "bun:test";

import { defaultConfig } from "../src/config.ts";
import { contextTick, handoffThreshold } from "../src/context.ts";
import { closeLane, type FlowDeps } from "../src/done-flow.ts";
import { depsFor, fakeClock, laneState, newWorld, ompPane, type TestState, withState, type World } from "./fakes.ts";
import { planPlacement } from "../src/placement.ts";
import type { Lane } from "../src/registry.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const lane = (key: string, patch: Partial<Lane> = {}): Lane => ({
  key,
  title: key,
  thread: "none",
  pane: `w9:${key}`,
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
  cwd: "/repo",
  model: "kiro-dori/claude-haiku-5.5",
  ...patch,
});

test("placement: no group is a tab, a group with no open lane gets a workspace, a group with an open lane splits below it", () => {
  const a = lane("a", { group: "g", openedAt: new Date(T0).toISOString() });
  const b = lane("b", { group: "g", openedAt: new Date(T0 + MIN).toISOString() });
  const closed = lane("c", { group: "h", closedAt: "2026-01-01T13:00:00.000Z" });
  expect(planPlacement([a], undefined)).toEqual({ kind: "tab" });
  expect(
    planPlacement(
      [a, closed].filter((l) => !l.closedAt),
      "h",
    ),
  ).toEqual({ kind: "workspace" });
  expect(planPlacement([a], "other")).toEqual({ kind: "workspace" });
  expect(planPlacement([a], "g")).toEqual({ kind: "split", near: { runtime: "herdr", id: "w9:a" } });
  expect(planPlacement([a, b], "g")).toEqual({ kind: "split", near: { runtime: "herdr", id: "w9:b" } });
});

const closeSetup = async (lanes: Lane[], target: string) => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  for (const l of lanes) await deps.registry.write(l);
  const r = await closeLane(deps, lanes.find((l) => l.key === target) as Lane, "done");
  expect(r.closed).toBe(true);
  return world.calls.filter((c) => c[0] === "herdr" && c[2] === "close").map((c) => `${c[1]} ${c[3]}`);
};

test("closing: a tab lane closes its tab, a split closes only its pane, the last lane of a dori-created workspace closes the workspace", async () => {
  expect(await closeSetup([lane("t", { tab: "w9:t5", placement: "tab", workspace: "w9" })], "t")).toEqual([
    "tab w9:t5",
  ]);
  world = newWorld();
  const root = lane("r", { group: "g", placement: "workspace", workspace: "w8", workspaceCreated: true, tab: "w8:t1" });
  const split = lane("s", { group: "g", placement: "split", workspace: "w8", tab: "w8:t1" });
  expect(await closeSetup([root, split], "r")).toEqual(["pane w9:r"]);
  world = newWorld();
  const after = await closeSetup([{ ...root, closedAt: "2026-01-01T12:30:00.000Z" }, split], "s");
  expect(after).toEqual(["workspace w8"]);
});

test("closing never closes a workspace dori did not create, or one another open lane still uses", async () => {
  const adopted = lane("x", { group: "g", placement: "split", workspace: "w5", tab: "w5:t1" });
  expect(await closeSetup([adopted], "x")).toEqual(["pane w9:x"]);
  world = newWorld();
  const root = lane("r", { group: "g", placement: "workspace", workspace: "w8", workspaceCreated: true });
  const other = lane("o", { group: "g", placement: "split", workspace: "w8" });
  expect(await closeSetup([root, other], "o")).toEqual(["pane w9:o"]);
  world = newWorld();
  expect(await closeSetup([root, other], "r")).toEqual(["pane w9:r"]);
});

test("closing keeps the lead session even when a lane record points at it", async () => {
  const l = lane("ld", { pane: "lead:p1", placement: "split", workspace: "w5" });
  expect(await closeSetup([l], "ld")).toEqual([]);
});

test("context threshold: claude-family models at 40, others at 60", () => {
  const c = defaultConfig("/h");
  expect(handoffThreshold(c, "kiro-dori/claude-haiku-5.5")).toBe(40);
  expect(handoffThreshold(c, "anthropic/Claude-Opus-5")).toBe(40);
  expect(handoffThreshold(c, "openai/gpt-6")).toBe(60);
  expect(handoffThreshold({ ...c, contextClaudePattern: "/claude|opus|sonnet|haiku/i" }, "x/sonnet")).toBe(40);
});

const withContext = async (l: Lane, model: string, percent: number, deps: FlowDeps) => {
  await deps.registry.write(l);
  ompPane(world, state.dir, l.pane ?? "", 4242, {
    state: { model, context: { percent, tokens: percent * 10, window: 1000 } },
  });
};

test("CONTEXT_HIGH prints once per crossing and re-arms after usage falls below the threshold", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await withContext(lane("c1", { pane: "w9:c1" }), "kiro-dori/claude-haiku-5.5", 45, deps);
  expect(await contextTick(deps, { relay: false })).toEqual(["CONTEXT_HIGH c1 w9:c1 kiro-dori/claude-haiku-5.5 45%"]);
  expect(await contextTick(deps, { relay: false })).toEqual([]);
  laneState(state.dir, "w9:c1", {
    model: "kiro-dori/claude-haiku-5.5",
    context: { percent: 20, tokens: 200, window: 1000 },
  });
  expect(await contextTick(deps, { relay: false })).toEqual([]);
  laneState(state.dir, "w9:c1", {
    model: "kiro-dori/claude-haiku-5.5",
    context: { percent: 50, tokens: 500, window: 1000 },
  });
  expect(await contextTick(deps, { relay: false })).toEqual(["CONTEXT_HIGH c1 w9:c1 kiro-dori/claude-haiku-5.5 50%"]);
});

test("a non-claude model at 50% is not high; at 60% it is", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await withContext(lane("c2", { pane: "w9:c2" }), "openai/gpt-6", 50, deps);
  expect(await contextTick(deps, { relay: false })).toEqual([]);
  laneState(state.dir, "w9:c2", { model: "openai/gpt-6", context: { percent: 61, tokens: 610, window: 1000 } });
  expect((await contextTick(deps, { relay: false }))[0]).toStartWith("CONTEXT_HIGH c2 w9:c2 openai/gpt-6 61%");
});

test("CONTEXT_UNKNOWN is printed once, only after the lane has been without data for 10 minutes", async () => {
  const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
  await at(T0).registry.write(lane("u1", { pane: "w9:u1" }));
  expect(await contextTick(at(T0 + 5 * MIN), { relay: false })).toEqual([]);
  expect(await contextTick(at(T0 + 11 * MIN), { relay: false })).toEqual(["CONTEXT_UNKNOWN u1 w9:u1"]);
  expect(await contextTick(at(T0 + 12 * MIN), { relay: false })).toEqual([]);
});
