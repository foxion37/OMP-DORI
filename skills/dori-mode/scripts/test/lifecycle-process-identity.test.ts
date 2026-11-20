import { afterEach, expect, test } from "bun:test";
import { type FlowDeps, watchTick } from "../src/done-flow.ts";
import { readPaneState } from "../src/lane-state.ts";
import { laneState } from "./fakes.ts";
import {
  closeFixture,
  expectClosed,
  expectHeld,
  failFirstClose,
  intentOf,
  lifecycleFixture,
  paneGone,
  removals,
  removeProcess,
  type LifecycleFixture,
} from "./lifecycle-fixture.ts";

let fixture: LifecycleFixture | undefined;
afterEach(() => fixture?.state.done());

const readyClaim = async () => {
  const f = await lifecycleFixture();
  fixture = f;
  return closeFixture(f);
};

test("a failed post-close kernel identity read holds until the native PID exits", async () => {
  const ctx = await readyClaim();
  ctx.f.keepProcessAlive();
  const reader = ctx.f.deps.platform;
  if (!reader) throw new Error("kernel identity reader is absent");
  const { procStat } = reader;
  let failed = false;
  const deps: FlowDeps = {
    ...ctx.f.deps,
    platform: {
      ...reader,
      procStat: (pid) => {
        if (paneGone(ctx)) {
          failed = true;
          throw new Error("kernel identity unavailable");
        }
        return procStat(pid);
      },
    },
  };
  await expectHeld(ctx, await watchTick(deps), 1);
  expect(failed).toBe(true);
  const intent = await intentOf(ctx);
  removeProcess(ctx, intent.process.pid);
  await expectClosed(ctx, await watchTick(ctx.f.deps));
});

test("a wall-clock shift cannot prove that a still-live native process exited", async () => {
  const ctx = await readyClaim();
  ctx.f.keepProcessAlive();
  const native = ctx.f.world.procs?.find((p) => p.pid === ctx.native.pid);
  if (!native) throw new Error("native process is absent");
  let shifted = false;
  const deps: FlowDeps = {
    ...ctx.f.deps,
    run: async (argv, options) => {
      if (shifted && argv[0] === "ps" && argv.includes("lstart="))
        return { code: 0, out: "Thu Jan  1 11:59:00 2026 GMT", err: "" };
      const result = await ctx.f.deps.run(argv, options);
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "close") shifted = true;
      return result;
    },
  };
  const lines = await watchTick(deps);
  expect(shifted).toBe(true);
  expect(ctx.f.world.procs?.find((p) => p.pid === ctx.native.pid)).toBe(native);
  console.log(JSON.stringify({ case: "wall-clock-shift", lines, pid: native.pid, removals: removals(ctx.f) }));
  await expectHeld(ctx, lines, 1);
});

test("PID reuse after close settles without targeting the replacement", async () => {
  const ctx = await readyClaim();
  ctx.f.keepProcessAlive();
  let pid: number | undefined;
  const deps: FlowDeps = {
    ...ctx.f.deps,
    run: async (argv, options) => {
      if (paneGone(ctx) && argv[0] === "ps" && argv[1] === "-A" && pid === undefined) {
        pid = (await intentOf(ctx)).process.pid;
        const row = ctx.f.world.procs?.find((p) => p.pid === pid);
        if (!row) throw new Error("native process is absent");
        row.cmd = "unrelated process";
        ctx.f.world.procStartTicks = { ...ctx.f.world.procStartTicks, [pid]: "reused-incarnation" };
      }
      if (paneGone(ctx) && argv[0] === "ps" && argv.includes("lstart=") && argv.at(-1) === String(pid)) {
        ctx.f.world.calls.push([...argv]);
        return { code: 0, out: "Thu Jan  1 12:01:00 2026 GMT", err: "" };
      }
      return ctx.f.deps.run(argv, options);
    },
  };
  await expectClosed(ctx, await watchTick(deps));
  expect(pid).toBeDefined();
  expect(ctx.f.world.procs?.find((p) => p.pid === pid)?.cmd).toBe("unrelated process");
  expect(ctx.f.world.calls.filter(([cmd]) => cmd === "kill")).toEqual([]);
});

test("a different boot distinguishes a replacement with the same PID and start tick", async () => {
  const ctx = await readyClaim();
  ctx.f.keepProcessAlive();
  await expectHeld(ctx, await watchTick(ctx.f.deps), 1);
  const intent = await intentOf(ctx);
  ctx.f.world.bootId = "replacement-boot";
  const procs = ctx.f.world.procs;
  if (!procs) throw new Error("native process table is absent");
  ctx.f.world.procs = procs.map((row) =>
    row.pid === intent.process.pid ? { ...row, cmd: "unrelated replacement" } : row,
  );
  await expectClosed(ctx, await watchTick(ctx.f.deps));
  expect(ctx.f.world.procs?.find((row) => row.pid === intent.process.pid)?.cmd).toBe("unrelated replacement");
  expect(ctx.f.world.calls.filter(([cmd]) => cmd === "kill")).toEqual([]);
});

test("PID reuse before retry cannot close a different native writer", async () => {
  const ctx = await readyClaim();
  await expectHeld(ctx, await watchTick(failFirstClose(ctx)), 1);
  const intent = await intentOf(ctx);
  const native = readPaneState(ctx.f.state.dir, ctx.ref.id);
  if (!native) throw new Error("native pane state is absent");
  const startedAt = "2026-01-01T12:01:00.000Z";
  laneState(ctx.f.state.dir, ctx.ref.id, { ...native, startedAt, updatedAt: startedAt });
  ctx.f.world.procStartTicks = { ...ctx.f.world.procStartTicks, [intent.process.pid]: "reused-incarnation" };
  const deps: FlowDeps = {
    ...ctx.f.deps,
    run: async (argv, options) => {
      if (argv[0] === "ps" && argv.includes("lstart=") && argv.at(-1) === String(intent.process.pid)) {
        ctx.f.world.calls.push([...argv]);
        return { code: 0, out: "Thu Jan  1 12:01:00 2026 GMT", err: "" };
      }
      return ctx.f.deps.run(argv, options);
    },
  };
  await expectHeld(ctx, await watchTick(deps), 1);
  expect(paneGone(ctx)).toBe(false);
  expect((await intentOf(ctx)).process).toEqual(intent.process);
});
