import { afterEach, expect, test } from "bun:test";
import { closeLane, type FlowDeps, watchTick } from "../src/done-flow.ts";
import { laneState } from "./fakes.ts";
import {
  closeFixture,
  closes,
  expectHeld,
  lifecycleFixture,
  removals,
  removeProcess,
  type LifecycleFixture,
} from "./lifecycle-fixture.ts";

let fixture: LifecycleFixture | undefined;
afterEach(() => fixture?.state.done());

const readyClaim = async () => {
  const f = await lifecycleFixture();
  fixture = f;
  return closeFixture(f, "idle", false);
};

test.each(["pane gone", "different session", "probe failed", "kernel unreadable"] as const)(
  "an unknown initial legacy close keeps its existing behavior: %s",
  async (unknown) => {
    const ctx = await readyClaim();
    let deps = ctx.f.deps;
    let proofReads = 0;
    if (unknown === "pane gone") {
      ctx.f.world.panes = ctx.f.world.panes.filter((pane) => pane.pane_id !== ctx.ref.id);
      removeProcess(ctx, ctx.native.pid);
    } else if (unknown === "different session") {
      await deps.registry.write({ ...ctx.claim, session: "01a11440-ee81-7f90-b2ed-dcc7d51a0ade" });
    } else if (unknown === "probe failed") {
      deps = {
        ...deps,
        run: async (argv, options) => {
          if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "get")
            throw new Error("native probe unavailable");
          return ctx.f.deps.run(argv, options);
        },
      };
    } else {
      const reader = deps.platform;
      if (!reader) throw new Error("kernel identity reader is absent");
      deps = {
        ...deps,
        platform: {
          ...reader,
          procStat: () => {
            proofReads++;
            throw new Error("kernel identity unavailable");
          },
        },
      };
    }
    expect(await watchTick(deps)).toEqual([expect.stringContaining(`LANE_CLOSED ${ctx.claim.key}`)]);
    expect(closes(ctx.f)).toEqual([["herdr", "tab", "close", ctx.ref.container!]]);
    expect(removals(ctx.f)).toHaveLength(1);
    const closed = await deps.registry.read(ctx.claim.key);
    expect(closed).toMatchObject({
      status: "closed",
      receipt: {
        outcome: "done",
        cleanup: [`tab ${ctx.ref.container} closed`, `worktree ${ctx.worktree} removed`],
      },
    });
    expect(closed?.nativeCloseIntent).toBeUndefined();
    if (unknown === "kernel unreadable") expect(proofReads).toBe(1);
  },
);

test("an initial lane cannot fall back to legacy cleanup after its process proof was prepared", async () => {
  const ctx = await readyClaim();
  const reader = ctx.f.deps.platform;
  if (!reader) throw new Error("kernel identity reader is absent");
  let reads = 0;
  const deps: FlowDeps = {
    ...ctx.f.deps,
    platform: {
      ...reader,
      procStat: (pid) => {
        if (++reads === 2) throw new Error("kernel identity unavailable after preparation");
        return reader.procStat(pid);
      },
    },
  };
  const held = await expectHeld(ctx, await watchTick(deps), 0);
  expect(reads).toBe(2);
  expect(held?.nativeCloseIntent?.process).toEqual({
    pid: ctx.native.pid,
    startTicks: String(ctx.native.pid),
    bootId: "fixture-boot",
  });
  expect(await watchTick(ctx.f.deps)).toEqual([expect.stringContaining(`LANE_CLOSED ${ctx.claim.key}`)]);
  expect(closes(ctx.f)).toEqual([["herdr", "tab", "close", ctx.ref.container!]]);
  expect(removals(ctx.f)).toHaveLength(1);
  expect((await ctx.f.deps.registry.read(ctx.claim.key))?.receipt).toMatchObject({
    cleanup: [`tab ${ctx.ref.container} closed`, `worktree ${ctx.worktree} removed`],
  });
});

test.each([
  ["manual", "before"],
  ["watch", "before"],
  ["manual", "readback"],
  ["watch", "readback"],
  ["manual", "kernel"],
  ["watch", "kernel"],
] as const)("%s preserves an initial main awaiting approval (%s)", async (operation, phase) => {
  const ctx = await readyClaim();
  const block = () =>
    laneState(ctx.f.state.dir, ctx.ref.id, {
      ...ctx.native,
      agentStatus: "working",
      approvalPending: true,
    });
  if (phase === "before") block();
  let reads = 0;
  let changed = false;
  const reader = ctx.f.deps.platform;
  if (!reader) throw new Error("kernel identity reader is absent");
  const deps: FlowDeps = {
    ...ctx.f.deps,
    platform: {
      ...reader,
      procStat: (pid) => {
        if (phase === "kernel") {
          changed = true;
          block();
          throw new Error("kernel identity unavailable while approval starts");
        }
        return reader.procStat(pid);
      },
    },
    run: async (argv, options) => {
      if (phase === "readback" && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "get" && ++reads === 2) {
        changed = true;
        block();
      }
      return ctx.f.deps.run(argv, options);
    },
  };
  let lines: string[];
  if (operation === "manual") {
    const result = await closeLane(deps, ctx.claim, "operator requested close");
    expect(result.closed).toBe(false);
    lines = result.lines;
  } else lines = await watchTick(deps);
  expect(lines.at(-1)).toContain("main agent is still working");
  expect(closes(ctx.f)).toEqual([]);
  expect(removals(ctx.f)).toEqual([]);
  expect(await ctx.f.deps.registry.read(ctx.claim.key)).toEqual(ctx.claim);
  if (phase !== "before") expect(changed).toBe(true);
});
