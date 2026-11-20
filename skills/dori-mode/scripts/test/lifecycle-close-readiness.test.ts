import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { closeLane, type FlowDeps, watchTick } from "../src/done-flow.ts";
import { readPaneState } from "../src/lane-state.ts";
import { parkLane } from "../src/park.ts";
import { pauseLane } from "../src/pause.ts";
import { type Lane, sessionOf, withStatus } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import { runtimesOf } from "../src/run.ts";
import { laneState } from "./fakes.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

const reopen = async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  expect(parked.code).toBe(0);
  const reopened = await reopenLane(f.deps, parked.lane);
  expect(reopened.code).toBe(0);
  expect(reopened.lane.lifecycleEpoch).toBeDefined();
  f.world.calls.length = 0;
  return reopened.lane;
};

const herdrEffects = () =>
  f.world.calls.filter(
    ([cmd, scope, verb]) =>
      cmd === "herdr" &&
      ((scope === "agent" && verb === "prompt") ||
        (scope === "pane" && (verb === "send-text" || verb === "send-keys" || verb === "close")) ||
        (scope === "tab" && verb === "close")),
  );
const worktreeRemovals = () =>
  f.world.calls.filter(([cmd, , , scope, verb]) => cmd === "git" && scope === "worktree" && verb === "remove");
const ok = (out = "") => ({ code: 0, out, err: "" });

test("an expired reopened claim closes its verified pane before the cost hook can change approval", async () => {
  const reopened = await reopen();
  const ref = sessionOf(reopened)!;
  const native = readPaneState(f.state.dir, ref.id)!;
  const worktree = join(f.state.dir, "owned-worktree");
  const evidence = "merge verified";
  const at = new Date(f.deps.clock.now() - 3_600_000).toISOString();
  const claim = withStatus(reopened, "done-claimed", evidence, at, {
    claim: { at, evidence, emitted: true },
    reportProtocol: "jsonl-v1",
    thread: "discord:fixture-thread",
    worktrees: [worktree],
  });
  await f.deps.registry.write(claim);

  const events: string[] = [];
  let registryAtPaneClose: Lane | null = null;
  let receiptAtCost: unknown;
  let paneLiveAtCost: boolean | undefined;
  const deps: FlowDeps = {
    ...f.deps,
    config: {
      ...f.deps.config,
      closeAfterMin: 5,
      hooks: { threadDone: ["fixture-thread-done"] },
      supervision: { usageArgv: ["fixture-usage"], recordCostArgv: ["fixture-cost"] },
    },
    run: async (argv, options) => {
      if (argv[0] === "fixture-usage") {
        events.push("usage");
        return ok('{"tokens":12,"costUsd":0}');
      }
      if (argv[0] === "fixture-cost") {
        events.push("cost");
        paneLiveAtCost = f.world.panes.some((pane) => pane.pane_id === ref.id);
        receiptAtCost = (await f.deps.registry.read(claim.key))?.receipt;
        laneState(f.state.dir, ref.id, { ...native, approvalPending: true });
        return ok();
      }
      if (argv[0] === "fixture-thread-done") {
        events.push("thread cleanup");
        return ok();
      }
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "close") {
        events.push("pane close");
        registryAtPaneClose = await f.deps.registry.read(claim.key);
      }
      if (argv[0] === "git" && argv[3] === "worktree" && argv[4] === "remove") events.push("worktree cleanup");
      return f.deps.run(argv, options);
    },
  };
  expect(await runtimesOf(deps).for(ref).probe(ref)).toMatchObject({
    sessionId: f.session,
    pid: native.pid,
    approvalPending: false,
    shellInFront: false,
  });

  const lines = await watchTick(deps);
  const registered = await deps.registry.read(claim.key);
  expect({
    events,
    paneLiveAtCost,
    livePanes: f.world.panes.map((pane) => pane.pane_id),
    status: registered?.status,
    receipt: registered?.receipt,
  }).toEqual({
    events: ["pane close", "usage", "cost", "thread cleanup", "worktree cleanup"],
    paneLiveAtCost: false,
    livePanes: [],
    status: "closed",
    receipt: expect.objectContaining({
      outcome: "done",
      cleanup: expect.arrayContaining([`pane ${ref.id} closed`, "thread marked done", `worktree ${worktree} removed`]),
    }),
  });
  expect(registryAtPaneClose).toMatchObject({ status: "done-claimed", claim: claim.claim });
  expect(receiptAtCost).toBeUndefined();
  expect(readPaneState(f.state.dir, ref.id)?.approvalPending).toBe(true);
  expect(lines).toEqual([expect.stringContaining(`LANE_CLOSED ${claim.key} `)]);
  expect(herdrEffects()).toEqual([["herdr", "pane", "close", ref.id]]);
  expect(worktreeRemovals()).toEqual([["git", "-C", f.deps.config.defaultCwd, "worktree", "remove", worktree]]);
});

for (const operation of ["close", "park"] as const) {
  test(`${operation} holds a reopened paused OMP lane when a shell script owns its foreground`, async () => {
    const reopened = await reopen();
    const paused = await pauseLane(f.deps, reopened, "fixture paused");
    expect(paused.code).toBe(0);
    f.world.calls.length = 0;
    const lane = {
      ...paused.lane,
      thread: "discord:fixture-thread",
      worktrees: [join(f.state.dir, "owned-worktree")],
    };
    await f.deps.registry.write(lane);
    const ref = sessionOf(lane)!;
    if (!ref.container) throw new Error("reopened native tab is absent");
    const before = await f.deps.registry.read(lane.key);
    expect(before).toMatchObject({ status: "paused", session: f.session });
    const native = readPaneState(f.state.dir, ref.id)!;
    expect(native).toMatchObject({ sessionId: f.session, goal: { status: "paused" }, approvalPending: false });
    const script = { name: "bash", argv: ["bash", "owner-script.sh"], pid: native.pid + 1 };
    const pane = f.world.panes.find((entry) => entry.pane_id === ref.id)!;
    pane.foreground = [script];
    f.world.procs?.push({ pid: script.pid, ppid: f.world.shells![ref.id]!, cmd: script.argv.join(" ") });
    const sibling = { pane_id: "w1:p9", workspace_id: "w1", tab_id: ref.container, foreground: "bash" };
    Object.assign(pane, { tab_id: ref.container });
    f.world.panes.push(sibling);
    const threadCleanup: string[][] = [];
    const deps: FlowDeps = {
      ...f.deps,
      config: { ...f.deps.config, hooks: { threadDone: ["fixture-thread-done"] } },
      run: async (argv, options) => {
        if (argv[0] === "fixture-thread-done") {
          threadCleanup.push([...argv]);
          return ok();
        }
        if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "close" && argv[3] === ref.container)
          f.world.panes = f.world.panes.filter((entry) => entry !== pane && entry !== sibling);
        return f.deps.run(argv, options);
      },
    };
    const runtime = runtimesOf(deps).for(ref);
    const foregroundIdentity = {
      sessionId: f.session,
      pid: native.pid,
      approvalPending: false,
      shellInFront: true,
      foreground: [script],
    };
    expect(await runtime.probe(ref)).toMatchObject(foregroundIdentity);

    if (operation === "close") {
      const result = await closeLane(deps, lane, "verified Done");
      expect(result.closed).toBe(false);
      expect(result.lines.at(-1)).toMatch(/^HELD /);
    } else {
      const result = await parkLane(deps, lane, "operator hold");
      expect(result.code).toBe(3);
      expect(result.lines[0]).toMatch(/^PARK_UNVERIFIED /);
    }
    expect(await deps.registry.read(lane.key)).toEqual(before);
    expect(herdrEffects()).toEqual([]);
    expect(worktreeRemovals()).toEqual([]);
    expect(threadCleanup).toEqual([]);
    expect(f.world.panes.map((entry) => entry.pane_id)).toEqual([ref.id, sibling.pane_id]);
    expect(await runtime.probe(ref)).toMatchObject(foregroundIdentity);
  });
}
