import { afterEach, beforeEach, expect, test } from "bun:test";
import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { type Runner, runtimesFor } from "../src/run.ts";
import { syncRegistry } from "../src/sync.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState, type World } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";

let dir: TestState;
let world: World;
beforeEach(() => {
  dir = withState();
  world = newWorld();
});
afterEach(() => dir.done());

for (const runtime of ["herdr", "hc"] as const) {
  test(`${runtime}: ungrouped panes do not stop watched scans or sync`, async () => {
    const deps = depsFor(world, fakeClock(0), dir.dir, { runtime, workspaces: ["w"] });
    world.panes = [{ pane_id: "watched", workspace_id: "w" }];
    world.screen = "agent has stopped";
    world.terminals = {
      t1: hcTerm({ labels: { "dori.group": "w" }, status: null, foreground: null, screen: "agent has stopped" }),
      t2: hcTerm(),
    };
    const listed: Runner = async (argv, options) => {
      if (argv[0] === "herdr" && argv[2] === "list")
        return {
          code: 0,
          out: JSON.stringify({ result: { panes: [...world.panes, { pane_id: "ungrouped" }] } }),
          err: "",
        };
      return deps.run(argv, options);
    };
    const rts = runtimesFor(deps.config, {}, listed);
    const state = newDeadPaneState();
    const seen = new Set<string>();
    const tick = () => deadPaneTick(listed, deps.config, seen, "hour", state, rts);
    expect(await tick()).toEqual([]);
    expect(await tick()).toEqual([`DEAD_PANE ${runtime === "herdr" ? "watched" : "t1"}`]);
    expect((await syncRegistry({ ...deps, run: listed, rts }, false)).unregistered).toEqual([]);
    world.panes = [];
    delete world.terminals["t1"];
    expect(await tick()).toEqual([]);
    expect(state.lastTail.size).toBe(0);
    expect(seen.size).toBe(0);
  });

  test(`${runtime}: vanished panes release unknown counts and screen tails`, async () => {
    const deps = depsFor(world, fakeClock(0), dir.dir, { runtime });
    const rts = runtimesFor(deps.config, {}, deps.run);
    const state = newDeadPaneState();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      world.panes = [{ pane_id: `w:p${i}`, workspace_id: "w" }];
      world.terminals = { [`t${i}`]: hcTerm({ status: null, foreground: null, screen: "unknown" }) };
      await deadPaneTick(deps.run, deps.config, seen, "hour", state, rts);
      world.calls = [];
    }
    world.panes = [];
    world.terminals = {};
    await deadPaneTick(deps.run, deps.config, seen, "next", state, rts);
    expect(state.unknown.size).toBe(0);
    expect(state.lastTail.size).toBe(0);
    expect(seen.size).toBe(0);
  });

  test(`${runtime}: a partial/failed watched snapshot preserves all prior state`, async () => {
    const deps = depsFor(world, fakeClock(0), dir.dir, { runtime, workspaces: ["first", "second"] });
    const state = newDeadPaneState();
    state.unknown.set("old", 2);
    state.lastTail.set("old", "prior screen");
    const seen = new Set(["old previous-hour"]);
    let lists = 0;
    const failing: Runner = async (argv, options) => {
      if ((argv[0] === "herdr" && argv[2] === "list") || (argv[0] === "hc" && argv[2] === "ls")) {
        if (++lists === 2) return { code: 1, out: "", err: "fixture list unavailable" };
      }
      return deps.run(argv, options);
    };
    await expect(
      deadPaneTick(failing, deps.config, seen, "new-hour", state, runtimesFor(deps.config, {}, failing)),
    ).rejects.toThrow();
    expect(lists).toBe(2);
    expect([...state.unknown]).toEqual([["old", 2]]);
    expect([...state.lastTail]).toEqual([["old", "prior screen"]]);
    expect([...seen]).toEqual(["old previous-hour"]);
  });
}

for (const runtime of ["herdr", "hc"] as const) {
  for (const workspaces of [[], ["w"]]) {
    for (const body of ["not JSON", "{}", "null", "[]", "null-rows", "missing-id", "wrong-state-or-group"]) {
      test(`${runtime}/${workspaces.length ? "watched" : "all"}: malformed ${body} preserves state`, async () => {
        const deps = depsFor(world, fakeClock(0), dir.dir, { runtime, workspaces });
        const state = newDeadPaneState();
        state.unknown.set("kept", 2);
        state.lastTail.set("kept", "prior");
        const seen = new Set(["kept prior-hour"]);
        const rows =
          body === "null-rows"
            ? [null]
            : body === "missing-id"
              ? [{}]
              : [{ pane_id: "w:p1", workspace_id: 1, address: "t1", state: 1 }];
        const out = ["null-rows", "missing-id", "wrong-state-or-group"].includes(body)
          ? JSON.stringify(runtime === "herdr" ? { result: { panes: rows } } : { terminals: rows })
          : body;
        const malformed: Runner = async (argv, options) => {
          if ((argv[0] === "herdr" && argv[2] === "list") || (argv[0] === "hc" && argv[2] === "ls"))
            return { code: 0, out, err: "" };
          return deps.run(argv, options);
        };
        await expect(
          deadPaneTick(malformed, deps.config, seen, "now", state, runtimesFor(deps.config, {}, malformed)),
        ).rejects.toThrow();
        expect([...state.unknown]).toEqual([["kept", 2]]);
        expect([...state.lastTail]).toEqual([["kept", "prior"]]);
        expect([...seen]).toEqual(["kept prior-hour"]);
      });
    }
  }
}

test("hour dedup retains only current live-pane keys, including across a backward clock step", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screen = "agent has stopped";
  const deps = depsFor(world, fakeClock(0), dir.dir);
  const rts = runtimesFor(deps.config, {}, deps.run);
  const state = newDeadPaneState();
  const seen = new Set<string>();
  const tick = (hour: string) => deadPaneTick(deps.run, deps.config, seen, hour, state, rts);
  expect(await tick("0")).toEqual([]);
  expect(await tick("0")).toEqual(["DEAD_PANE w:p1"]);
  expect(await tick("0")).toEqual([]);
  for (let i = 1; i <= 720; i++) {
    expect(await tick(String(i))).toEqual(["DEAD_PANE w:p1"]);
    expect([...seen]).toEqual([`w:p1 ${i}`]);
    world.calls = [];
  }
  expect(await tick("0")).toEqual(["DEAD_PANE w:p1"]);
  expect(await tick("0")).toEqual([]);
  world.panes = [];
  expect(await tick("0")).toEqual([]);
  expect(seen.size).toBe(0);
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  expect(await tick("0")).toEqual([]);
  expect(await tick("0")).toEqual(["DEAD_PANE w:p1"]);
});

test("disappearance resets the three-tick unknown streak and alive status still clears tails", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  const deps = depsFor(world, fakeClock(0), dir.dir);
  const rts = runtimesFor(deps.config, {}, deps.run);
  const state = newDeadPaneState();
  const seen = new Set<string>();
  const tick = () => deadPaneTick(deps.run, deps.config, seen, "hour", state, rts);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
  world.panes = [];
  await tick();
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual(["UNRECOGNISED_PANE w:p1 dead-panes: no alive status and no dead marker for 3 ticks"]);
  expect(await tick()).toEqual([]);
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  expect(await tick()).toEqual([]);
  expect(state.unknown.size).toBe(0);
  expect(state.lastTail.size).toBe(0);
});

test("a pane moved outside watched groups or into ignorePanes releases its retained state", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screen = "agent has stopped";
  const deps = depsFor(world, fakeClock(0), dir.dir, { workspaces: ["w"] });
  const rts = runtimesFor(deps.config, {}, deps.run);
  const state = newDeadPaneState();
  const seen = new Set<string>();
  await deadPaneTick(deps.run, deps.config, seen, "hour", state, rts);
  await deadPaneTick(deps.run, deps.config, seen, "hour", state, rts);
  await deadPaneTick(deps.run, { ...deps.config, ignorePanes: ["w:p1"] }, seen, "hour", state, rts);
  expect(state.lastTail.size).toBe(0);
  expect(seen.size).toBe(0);
  await deadPaneTick(deps.run, deps.config, seen, "hour", state, rts);
  world.panes = [{ pane_id: "w:p1", workspace_id: "elsewhere" }];
  await deadPaneTick(deps.run, deps.config, seen, "hour", state, rts);
  expect(state.lastTail.size).toBe(0);
});
