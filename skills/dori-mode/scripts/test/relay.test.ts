import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { contextTick, handoffThreshold } from "../src/context.ts";
import { closeLane } from "../src/done-flow.ts";
import { defaultConfig } from "../src/config.ts";
import { planPlacement } from "../src/placement.ts";
import type { Lane } from "../src/registry.ts";
import { relayLane } from "../src/relay.ts";
import { agentIn, depsFor, fakeClock, fakeRunner, laneState, newWorld, sent, withState, type World } from "./fakes.ts";
import type { FlowDeps } from "../src/done-flow.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const lane = (key: string, patch: Partial<Lane> = {}): Lane => ({ key, title: key, thread: "none", pane: `w9:${key}`, brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), cwd: "/repo", model: "kiro-dori/claude-haiku-5.5", ...patch });

/** A runner that also answers herdr's workspace/split/run/close calls and keeps `world.panes` in step. */
const herdr = (w: World, next: { n: number }, splitStatus: string | undefined = "idle") => {
  const inner = fakeRunner(w);
  return async (argv: readonly string[]) => {
    const [cmd, a1, a2] = argv;
    if (cmd === "herdr" && a1 === "pane" && a2 === "split") {
      w.calls.push([...argv]);
      const id = `w9:new${++next.n}`;
      w.panes.push({ pane_id: id, workspace_id: "w9", ...(splitStatus ? { agent: "omp", agent_status: splitStatus } : {}) });
      return { code: 0, out: JSON.stringify({ result: { pane: { pane_id: id, tab_id: "w9:t1", workspace_id: "w9" } } }), err: "" };
    }
    if (cmd === "herdr" && a1 === "workspace" && a2 === "create") {
      w.calls.push([...argv]);
      return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w8:p1", tab_id: "w8:t1", workspace_id: "w8" }, workspace: { workspace_id: "w8" } } }), err: "" };
    }
    return inner(argv);
  };
};

const closes = (w: World): string[] => w.calls.filter((c) => c[0] === "herdr" && c[2] === "close" || c[0] === "herdr" && c[1] === "workspace" && c[2] === "close").map((c) => `${c[1]} ${c[3]}`);

test("placement: no group is a tab, a group with no open lane gets a workspace, a group with open lanes splits the newest, alternating", () => {
  const a = lane("a", { group: "g", openedAt: new Date(T0).toISOString() });
  const b = lane("b", { group: "g", openedAt: new Date(T0 + MIN).toISOString() });
  const closed = lane("c", { group: "h", closedAt: "2026-01-01T13:00:00.000Z" });
  expect(planPlacement([a], undefined)).toEqual({ kind: "tab" });
  expect(planPlacement([a, closed].filter((l) => !l.closedAt), "h")).toEqual({ kind: "workspace" });
  expect(planPlacement([a], "other")).toEqual({ kind: "workspace" });
  expect(planPlacement([a], "g")).toEqual({ kind: "split", from: a, direction: "right" });
  expect(planPlacement([a, b], "g")).toEqual({ kind: "split", from: b, direction: "down" });
});

const closeSetup = async (lanes: Lane[], target: string) => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  for (const l of lanes) await deps.registry.write(l);
  const r = await closeLane(deps, lanes.find((l) => l.key === target) as Lane, "done");
  expect(r.closed).toBe(true);
  return closes(world);
};

test("closing: a tab lane closes its tab, a split closes only its pane, the last lane of a dori-created workspace closes the workspace", async () => {
  expect(await closeSetup([lane("t", { tab: "w9:t5", placement: "tab", workspace: "w9" })], "t")).toEqual(["tab w9:t5"]);
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

test("closing keeps the lead pane even when a lane record points at it", async () => {
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
  agentIn(world, l.pane ?? "");
  laneState(state.dir, l.pane ?? "", { model, context: { percent, tokens: percent * 10, window: 1000 } });
};

test("CONTEXT_HIGH prints once per crossing and re-arms after usage falls below the threshold", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await withContext(lane("c1", { pane: "w9:c1" }), "kiro-dori/claude-haiku-5.5", 45, deps);
  expect(await contextTick(deps, { relay: false })).toEqual(["CONTEXT_HIGH c1 w9:c1 kiro-dori/claude-haiku-5.5 45%"]);
  expect(await contextTick(deps, { relay: false })).toEqual([]);
  laneState(state.dir, "w9:c1", { model: "kiro-dori/claude-haiku-5.5", context: { percent: 20, tokens: 200, window: 1000 } });
  expect(await contextTick(deps, { relay: false })).toEqual([]);
  laneState(state.dir, "w9:c1", { model: "kiro-dori/claude-haiku-5.5", context: { percent: 50, tokens: 500, window: 1000 } });
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

/** A clock that moves when slept on, so timeouts elapse. */
const ticking = (start: number) => {
  const c = { at: start, now: () => c.at, sleep: async (ms: number) => void (c.at += ms) };
  return c;
};

const relaySetup = async (opts: { writeHandoff?: boolean; splitStatus?: string | undefined; approval?: boolean; paneStatus?: string } = {}) => {
  const next = { n: 0 };
  const clock = ticking(T0);
  const base = depsFor(world, clock, state.dir, { relayTimeoutMin: 1 });
  const deps: FlowDeps = { ...base, run: herdr(world, next, "splitStatus" in opts ? opts.splitStatus : "idle") };
  const l = lane("rl", { pane: "w9:rl", workspace: "w9", tab: "w9:t1", placement: "split", group: "g" });
  await deps.registry.write(l);
  world.panes.push({ pane_id: "w9:rl", workspace_id: "w9", agent: "omp", agent_status: opts.paneStatus ?? "idle" });
  agentIn(world, "w9:rl");
  laneState(state.dir, "w9:rl", { approvalPending: opts.approval ?? false });
  if (opts.writeHandoff !== false) {
    world.onSendText = (_pane, text) => {
      const path = /to (\S+\.md)/.exec(text)?.[1];
      if (path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "# handoff\ngoal: x\n");
      }
    };
  }
  return { deps, lane: l };
};

test("relay: handoff, successor split next to the lane, registry updated, old pane closed", async () => {
  const { deps, lane: l } = await relaySetup();
  const r = await relayLane(deps, l);
  expect(r.lines).toEqual(["RELAYED rl w9:rl -> w9:new1"]);
  const saved = (await deps.registry.read("rl")) as Lane;
  expect(saved).toMatchObject({ pane: "w9:new1", relays: 1, previousPanes: ["w9:rl"], placement: "split" });
  expect(world.calls.find((c) => c[2] === "split")).toEqual(["herdr", "pane", "split", "w9:rl", "--direction", "right", "--cwd", "/repo", "--no-focus"]);
  const run = world.calls.find((c) => c[2] === "run");
  expect(run?.[3]).toBe("w9:new1");
  expect(run?.[4]).toContain("handoffs/rl-1.md");
  expect(closes(world)).toEqual(["pane w9:rl"]);
  expect(existsSync(`${state.dir}/handoffs/rl-1.md`)).toBe(true);
});

test("relay: no handoff before the timeout prints RELAY_FAILED and changes nothing", async () => {
  const { deps, lane: l } = await relaySetup({ writeHandoff: false });
  const r = await relayLane(deps, l);
  expect(r.lines).toEqual(["RELAY_FAILED rl handoff not written"]);
  expect(world.calls.some((c) => c[2] === "split" || c[2] === "close")).toBe(false);
  expect((await deps.registry.read("rl")) as Lane).toMatchObject({ pane: "w9:rl" });
});

test("relay: a successor that fails to start is closed and the old lane stays as it was", async () => {
  const { deps, lane: l } = await relaySetup({ splitStatus: undefined });
  world.screen = "No API key found\n$ ";
  const r = await relayLane(deps, l);
  expect(r.lines[0]).toStartWith("RELAY_FAILED rl successor did not start");
  expect(closes(world)).toEqual(["pane w9:new1"]);
  const saved = (await deps.registry.read("rl")) as Lane;
  expect(saved.pane).toBe("w9:rl");
  expect(saved.relays).toBeUndefined();
});

test("relay: an open approval prompt, or a blocked agent, is skipped and nothing is sent", async () => {
  const a = await relaySetup({ approval: true });
  expect((await relayLane(a.deps, a.lane)).lines[0]).toStartWith("RELAY_SKIPPED rl");
  expect(sent(world)).toEqual([]);
  world = newWorld();
  const b = await relaySetup({ paneStatus: "blocked" });
  expect((await relayLane(b.deps, b.lane)).lines[0]).toStartWith("RELAY_SKIPPED rl");
  expect(sent(world)).toEqual([]);
});

test("--relay runs the relay at the crossing; a failed relay is not retried until the crossing resets", async () => {
  const { deps } = await relaySetup({ writeHandoff: false });
  laneState(state.dir, "w9:rl", { model: "kiro-dori/claude-haiku-5.5", context: { percent: 55, tokens: 550, window: 1000 } });
  const first = await contextTick(deps, { relay: true });
  expect(first).toEqual(["CONTEXT_HIGH rl w9:rl kiro-dori/claude-haiku-5.5 55%", "RELAY_FAILED rl handoff not written"]);
  expect(await contextTick(deps, { relay: true })).toEqual([]);
});
