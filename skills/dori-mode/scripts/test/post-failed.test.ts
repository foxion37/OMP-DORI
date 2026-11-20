import { afterEach, beforeEach, expect, test } from "bun:test";

import type { FlowDeps } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = {
  key: "post-lane",
  title: "post",
  thread: "telegram:1/2",
  pane: "w:p1",
  brief: "/b.md",
  done: "closed acme/app#1",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
};

let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
});
afterEach(() => state.done());

test("a thread hook that keeps failing is tried every tick but reported once per failure", async () => {
  const clock = fakeClock(T0 + 30 * MIN);
  const base = depsFor(world, clock, state.dir, {
    nudgeAfterMin: 999,
    postAfterMin: 1,
    hooks: { threadReply: ["notify", "{thread}", "{text}"] },
  });
  await base.registry.write(lane);
  new Reports(state.dir).report(lane.key, "blocker", "needs owner decision", T0);
  const outcomes = [1, 1, 2, 0];
  let hookCalls = 0;
  const deps: FlowDeps = {
    ...base,
    run: async (argv, opts) => {
      if (argv[0] !== "notify") return base.run(argv, opts);
      hookCalls++;
      return { code: outcomes.shift() ?? 0, out: "", err: "" };
    },
  };
  const tick = async () => {
    const acts = await freshnessTick(deps, "/home/test");
    clock.at += 2 * MIN;
    return acts.map((a) => `${a.kind} ${a.detail}`);
  };

  expect(await tick()).toEqual(["post-failed thread hook failed (exit 1)"]);
  // The same failure again is retried silently: a monitor on POST-FAILED is not woken every tick.
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual(["post-failed thread hook failed (exit 2)"]);
  expect((await tick()).map((a) => a.split(" ")[0])).toEqual(["posted"]);
  expect(hookCalls).toBe(4);
  expect((await deps.registry.read(lane.key))?.lastFreshnessNote).toBeUndefined();
});
