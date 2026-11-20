import { afterEach, expect, test } from "bun:test";
import { closeLane, watchTick } from "../src/done-flow.ts";
import { laneState } from "./fakes.ts";
import { closeFixture, closes, lifecycleFixture, removals, type LifecycleFixture } from "./lifecycle-fixture.ts";

let fixture: LifecycleFixture | undefined;
afterEach(() => fixture?.state.done());

const readyClaim = async (agentStatus: "idle" | "working", reopen = true) => {
  const f = await lifecycleFixture();
  fixture = f;
  return closeFixture(f, agentStatus, reopen);
};

test("an expired Done claim does not close a main agent that is still working", async () => {
  const { f, claim } = await readyClaim("working");
  const lines = await watchTick(f.deps);
  console.log(JSON.stringify({ case: "working-main", lines, closes: closes(f), removals: removals(f) }));
  expect(closes(f)).toEqual([]);
  expect(removals(f)).toEqual([]);
  expect((await f.deps.registry.read(claim.key))?.status).toBe("done-claimed");
  expect(lines).toEqual([expect.stringContaining("LANE_HELD")]);
});

test("pane absence alone cannot settle a close while the exact native process remains", async () => {
  const { f, ref, native, claim } = await readyClaim("idle");
  // A terminal acknowledgement can precede process exit: leave the verified process identity alive.
  f.keepProcessAlive();
  const lines = await watchTick(f.deps);
  expect(f.world.panes.some((pane) => pane.pane_id === ref.id)).toBe(false);
  expect(f.world.procs?.some((process) => process.pid === native.pid)).toBe(true);
  expect(closes(f)).toEqual([["herdr", "pane", "close", ref.id]]);
  console.log(JSON.stringify({ case: "pane-gone-process-live", lines, pid: native.pid, removals: removals(f) }));
  expect(removals(f)).toEqual([]);
  expect((await f.deps.registry.read(claim.key))?.status).toBe("done-claimed");
  expect(lines).toEqual([expect.stringContaining("LANE_HELD")]);
});

test("an initial native lane also refuses an expired claim while its main is working", async () => {
  const { f, claim } = await readyClaim("working", false);
  expect(claim.lifecycleEpoch).toBeUndefined();
  expect(await watchTick(f.deps)).toEqual([expect.stringContaining("main agent is still working")]);
  expect(closes(f)).toEqual([]);
  expect(removals(f)).toEqual([]);
  expect(await f.deps.registry.read(claim.key)).toEqual(claim);
});

test.each([false, true])("manual close cannot bypass a working main (reopened=%s)", async (reopen) => {
  const { f, claim } = await readyClaim("working", reopen);
  const result = await closeLane(f.deps, claim, "operator requested close");
  expect(result.closed).toBe(false);
  expect(result.lines.at(-1)).toContain("main agent is still working");
  expect(closes(f)).toEqual([]);
  expect(removals(f)).toEqual([]);
  expect(await f.deps.registry.read(claim.key)).toEqual(claim);
});

test.each([false, true])("a normal native exit still settles the Done claim (reopened=%s)", async (reopen) => {
  const { f, ref, native, claim } = await readyClaim("idle", reopen);
  expect(await watchTick(f.deps)).toEqual([expect.stringContaining(`LANE_CLOSED ${claim.key}`)]);
  expect(closes(f)).toEqual([["herdr", reopen ? "pane" : "tab", "close", reopen ? ref.id : ref.container!]]);
  expect(f.world.procs?.some((process) => process.pid === native.pid)).toBe(false);
  expect(removals(f)).toHaveLength(1);
  const closed = await f.deps.registry.read(claim.key);
  expect(closed).toMatchObject({
    status: "closed",
    receipt: {
      outcome: "done",
      cleanup: [
        `${reopen ? `pane ${ref.id}` : `tab ${ref.container}`} closed`,
        `worktree ${claim.worktrees?.[0]} removed`,
      ],
    },
  });
  expect(closed?.nativeCloseIntent).toBeUndefined();
  expect(await watchTick(f.deps)).toEqual([]);
  expect(removals(f)).toHaveLength(1);
});

test("an initial native lane waits for its process even when container close succeeded", async () => {
  const { f, ref, native, claim } = await readyClaim("idle", false);
  f.keepProcessAlive();
  expect(await watchTick(f.deps)).toEqual([expect.stringContaining(`native process ${native.pid} is still present`)]);
  expect(closes(f)).toEqual([["herdr", "tab", "close", ref.container!]]);
  expect(f.world.panes.some((pane) => pane.pane_id === ref.id)).toBe(false);
  expect(f.world.procs?.some((process) => process.pid === native.pid)).toBe(true);
  expect(removals(f)).toEqual([]);
  const held = await f.deps.registry.read(claim.key);
  expect(held).toMatchObject({
    status: "done-claimed",
    nativeCloseIntent: { openedAt: claim.openedAt, process: { pid: native.pid } },
  });
  expect(held?.nativeCloseIntent?.epoch).toBeUndefined();
  expect(held?.receipt).toBeUndefined();
});

test("a native main that already shut down still permits normal initial cleanup", async () => {
  const { f, ref, native, claim } = await readyClaim("idle", false);
  laneState(f.state.dir, ref.id, {
    ...native,
    pid: 0,
    agentStatus: "idle",
    approvalPending: false,
    updatedAt: new Date(f.deps.clock.now()).toISOString(),
  });
  if (f.world.procs) f.world.procs = f.world.procs.filter((process) => process.pid !== native.pid);
  const pane = f.world.panes.find((entry) => entry.pane_id === ref.id);
  const shell = f.world.shells?.[ref.id];
  if (!pane || shell === undefined) throw new Error("initial shell is absent");
  delete pane.agent;
  delete pane.agent_status;
  pane.foreground = [{ name: "zsh", argv: ["-zsh"], pid: shell }];
  expect(await watchTick(f.deps)).toEqual([expect.stringContaining(`LANE_CLOSED ${claim.key}`)]);
  expect(closes(f)).toEqual([["herdr", "tab", "close", ref.container!]]);
  expect(removals(f)).toHaveLength(1);
  expect((await f.deps.registry.read(claim.key))?.status).toBe("closed");
});

test("a first-run native session not yet saved by sync gains its verified identity before close", async () => {
  const { f, native, claim } = await readyClaim("idle", false);
  const { session: _session, ...unsynced } = claim;
  await f.deps.registry.write(unsynced);
  expect(await watchTick(f.deps)).toEqual([expect.stringContaining(`LANE_CLOSED ${claim.key}`)]);
  expect((await f.deps.registry.read(claim.key))?.session).toBe(native.sessionId);
  expect(removals(f)).toHaveLength(1);
});

test("a main that starts working after close preparation is held before terminal close", async () => {
  const { f, ref, native, claim } = await readyClaim("idle");
  let started = false;
  const lines = await watchTick({
    ...f.deps,
    run: async (argv, options) => {
      if (
        !started &&
        argv[0] === "herdr" &&
        argv[1] === "pane" &&
        argv[2] === "get" &&
        (await f.deps.registry.read(claim.key))?.nativeCloseIntent
      ) {
        started = true;
        laneState(f.state.dir, ref.id, { ...native, agentStatus: "working" });
      }
      return f.deps.run(argv, options);
    },
  });
  expect(started).toBe(true);
  expect(lines).toEqual([expect.stringContaining("main agent is still working")]);
  expect(closes(f)).toEqual([]);
  expect(removals(f)).toEqual([]);
  expect((await f.deps.registry.read(claim.key))?.nativeCloseIntent?.process?.pid).toBe(native.pid);
});
