import { afterEach, expect, test } from "bun:test";
import { type FlowDeps, watchTick } from "../src/done-flow.ts";
import {
  closeFixture,
  closes,
  expectClosed,
  expectHeld,
  failFirstClose,
  intentOf,
  lifecycleFixture,
  paneGone,
  removals,
  removeProcess,
  type CloseFixture,
  type LifecycleFixture,
} from "./lifecycle-fixture.ts";

let fixture: LifecycleFixture | undefined;
afterEach(() => fixture?.state.done());

const readyClaim = async () => {
  const f = await lifecycleFixture();
  fixture = f;
  return closeFixture(f);
};

const withoutProof = async (ctx: CloseFixture) => {
  const lane = await ctx.f.deps.registry.read(ctx.claim.key);
  if (!lane?.nativeCloseIntent) throw new Error("prepared intent is absent");
  const { process: _process, openedAt: _openedAt, ...legacy } = lane.nativeCloseIntent;
  await ctx.f.deps.registry.write({ ...lane, nativeCloseIntent: legacy });
};

test("a live native process holds repeated ticks until its exact PID exits", async () => {
  const ctx = await readyClaim();
  ctx.f.keepProcessAlive();
  await expectHeld(ctx, await watchTick(ctx.f.deps), 1);
  const intent = await intentOf(ctx);
  expect(paneGone(ctx)).toBe(true);
  expect(ctx.f.world.procs?.some((p) => p.pid === intent.process.pid)).toBe(true);
  await expectHeld(ctx, await watchTick(ctx.f.deps), 1);
  removeProcess(ctx, intent.process.pid);
  await expectClosed(ctx, await watchTick(ctx.f.deps));
});

test("a failed post-close process table holds until a fresh tick", async () => {
  const ctx = await readyClaim();
  const deps: FlowDeps = {
    ...ctx.f.deps,
    run: async (argv, options) => {
      if (paneGone(ctx) && argv[0] === "ps" && argv[1] === "-A") {
        ctx.f.world.calls.push([...argv]);
        return { code: 1, out: "", err: "ps failed" };
      }
      return ctx.f.deps.run(argv, options);
    },
  };
  await expectHeld(ctx, await watchTick(deps), 1);
  expect(paneGone(ctx)).toBe(true);
  await intentOf(ctx);
  await expectClosed(ctx, await watchTick(ctx.f.deps));
});

test.each([
  ["empty", ""],
  ["malformed", "not a process row"],
] as const)("a %s post-close process table holds cleanup", async (_label, out) => {
  const ctx = await readyClaim();
  const deps: FlowDeps = {
    ...ctx.f.deps,
    run: async (argv, options) => {
      if (paneGone(ctx) && argv[0] === "ps" && argv[1] === "-A") {
        ctx.f.world.calls.push([...argv]);
        return { code: 0, out, err: "" };
      }
      return ctx.f.deps.run(argv, options);
    },
  };
  await expectHeld(ctx, await watchTick(deps), 1);
  expect(paneGone(ctx)).toBe(true);
  await intentOf(ctx);
});

test("a legacy prepared intent acquires process proof from its live pane", async () => {
  const ctx = await readyClaim();
  await expectHeld(ctx, await watchTick(failFirstClose(ctx)), 1);
  const original = await intentOf(ctx);
  await withoutProof(ctx);
  let proofSeen = false;
  const deps: FlowDeps = {
    ...ctx.f.deps,
    run: async (argv, options) => {
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "close") {
        const lane = await ctx.f.deps.registry.read(ctx.claim.key);
        expect(lane?.nativeCloseIntent?.process).toEqual(original.process);
        proofSeen = true;
      }
      return ctx.f.deps.run(argv, options);
    },
  };
  const lines = await watchTick(deps);
  expect(proofSeen).toBe(true);
  const lane = await ctx.f.deps.registry.read(ctx.claim.key);
  expect(lines).toEqual([`LANE_CLOSED ${ctx.claim.key} ${JSON.stringify(lane?.receipt)}`]);
  expect(lane).toMatchObject({ status: "closed", receipt: { outcome: "done" } });
  expect(closes(ctx.f)).toHaveLength(2);
  expect(removals(ctx.f)).toHaveLength(1);
});

test("a legacy prepared intent without a pane cannot acquire process proof", async () => {
  const ctx = await readyClaim();
  const deps: FlowDeps = {
    ...ctx.f.deps,
    run: async (argv, options) => {
      if (paneGone(ctx) && argv[0] === "ps" && argv[1] === "-A") {
        ctx.f.world.calls.push([...argv]);
        return { code: 1, out: "", err: "ps failed" };
      }
      return ctx.f.deps.run(argv, options);
    },
  };
  await expectHeld(ctx, await watchTick(deps), 1);
  await intentOf(ctx);
  await withoutProof(ctx);
  const lane = await expectHeld(ctx, await watchTick(ctx.f.deps), 1);
  expect(lane?.nativeCloseIntent?.process).toBeUndefined();
  expect(paneGone(ctx)).toBe(true);
});
