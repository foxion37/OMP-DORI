import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { contextTick } from "../src/context.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { depsFor, laneState, newWorld, ompPane, sent, type TestState, withState, type World } from "./fakes.ts";
import type { Lane } from "../src/registry.ts";
import { relayLane } from "../src/relay.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
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

/** The split the relay asks for: herdr's answer, and how the successor session then reports itself. */
const splitAnswer = (next: { n: number }, status?: string) => (argv: readonly string[]) => {
  if (argv[0] !== "herdr" || argv[1] !== "pane" || argv[2] !== "split") return undefined;
  world.calls.push([...argv]);
  const id = `w9:new${++next.n}`;
  if (status === undefined) world.panes.push({ pane_id: id, workspace_id: "w9" });
  else ompPane(world, state.dir, id, 5000 + next.n, { status });
  return {
    code: 0,
    out: JSON.stringify({ result: { pane: { pane_id: id, tab_id: "w9:t1", workspace_id: "w9" } } }),
    err: "",
  };
};

/** A clock that moves when slept on, so timeouts elapse. */
const ticking = (start: number) => {
  const c = {
    at: start,
    now: () => c.at,
    sleep: async (ms: number) => {
      c.at += ms;
    },
  };
  return c;
};

const relaySetup = async (
  opts: { writeHandoff?: boolean; startStatus?: string | undefined; approval?: boolean; paneStatus?: string } = {},
) => {
  const next = { n: 0 };
  const base = depsFor(world, ticking(T0), state.dir, { relayTimeoutMin: 1 });
  const split = splitAnswer(next, "startStatus" in opts ? opts.startStatus : "idle");
  const deps: FlowDeps = { ...base, run: async (argv) => split(argv) ?? base.run(argv) };
  const l = lane("rl", { pane: "w9:rl", workspace: "w9", tab: "w9:t1", placement: "split", group: "g" });
  await deps.registry.write(l);
  ompPane(world, state.dir, "w9:rl", 4242, {
    ...(opts.paneStatus === undefined ? {} : { status: opts.paneStatus }),
    state: { approvalPending: opts.approval ?? false },
  });
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

const closedSessions = (): string[] =>
  world.calls.filter((c) => c[0] === "herdr" && c[2] === "close").map((c) => c[3] ?? "");

test("relay: handoff, successor split below the lane, registry updated, old session closed", async () => {
  const { deps, lane: l } = await relaySetup();
  const r = await relayLane(deps, l);
  expect(r.lines).toEqual(["RELAYED rl w9:rl -> w9:new1"]);
  const saved = (await deps.registry.read("rl")) as Lane;
  expect(saved).toMatchObject({ pane: "w9:new1", relays: 1, previousPanes: ["w9:rl"], placement: "split" });
  expect(world.calls.find((c) => c[2] === "split")).toEqual([
    "herdr",
    "pane",
    "split",
    "w9:rl",
    "--direction",
    "down",
    "--ratio",
    "0.3",
    "--cwd",
    "/repo",
    "--no-focus",
  ]);
  const run = world.calls.find((c) => c[2] === "run");
  expect(run?.[3]).toBe("w9:new1");
  expect(run?.[4]).toContain("handoffs/rl-1.md");
  expect(closedSessions()).toEqual(["w9:rl"]);
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
  const { deps, lane: l } = await relaySetup({ startStatus: undefined });
  world.screen = "No API key found\n$ ";
  const r = await relayLane(deps, l);
  expect(r.lines[0]).toStartWith("RELAY_FAILED rl successor did not start");
  expect(closedSessions()).toEqual(["w9:new1"]);
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
  laneState(state.dir, "w9:rl", {
    model: "kiro-dori/claude-haiku-5.5",
    context: { percent: 55, tokens: 550, window: 1000 },
  });
  const first = await contextTick(deps, { relay: true });
  expect(first).toEqual([
    "CONTEXT_HIGH rl w9:rl kiro-dori/claude-haiku-5.5 55%",
    "RELAY_FAILED rl handoff not written",
  ]);
  expect(await contextTick(deps, { relay: true })).toEqual([]);
});
