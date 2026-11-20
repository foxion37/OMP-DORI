import { afterEach, expect, test } from "bun:test";
import { type FlowDeps, watchTick } from "../src/done-flow.ts";
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

const readyHeld = async (exited: boolean) => {
  const f = await lifecycleFixture();
  fixture = f;
  const ctx = await closeFixture(f, "idle", false);
  let failed = false;
  const deps: FlowDeps = {
    ...ctx.f.deps,
    run: async (argv, options) => {
      if (!failed && argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "close") {
        failed = true;
        ctx.f.world.calls.push([...argv]);
        return { code: 1, out: "", err: "close refused" };
      }
      return ctx.f.deps.run(argv, options);
    },
  };
  await expectHeld(ctx, await watchTick(deps), 1);
  expect(failed).toBe(true);
  if (exited) removeProcess(ctx, ctx.native.pid);
  laneState(ctx.f.state.dir, ctx.ref.id, { ...ctx.native, pid: 0, agentStatus: "idle", approvalPending: false });
  const pane = ctx.f.world.panes.find((entry) => entry.pane_id === ctx.ref.id);
  const shell = ctx.f.world.shells?.[ctx.ref.id];
  if (!pane || shell === undefined) throw new Error("initial shell is absent");
  delete pane.agent;
  delete pane.agent_status;
  pane.foreground = [{ name: "zsh", argv: ["-zsh"], pid: shell }];
  expect(ctx.f.world.procs?.some((process) => process.pid === ctx.native.pid)).toBe(!exited);
  return ctx;
};

test.each([false, true])(
  "an interrupted initial close rechecks its process before a bare shell (exited=%s)",
  async (exited) => {
    const ctx = await readyHeld(exited);
    const lines = await watchTick(ctx.f.deps);
    if (exited) {
      expect(lines).toEqual([expect.stringContaining(`LANE_CLOSED ${ctx.claim.key}`)]);
      expect(closes(ctx.f)).toEqual([
        ["herdr", "tab", "close", ctx.ref.container!],
        ["herdr", "tab", "close", ctx.ref.container!],
      ]);
      expect(removals(ctx.f)).toHaveLength(1);
      expect((await ctx.f.deps.registry.read(ctx.claim.key))?.nativeCloseIntent).toBeUndefined();
      expect(await watchTick(ctx.f.deps)).toEqual([]);
      expect(removals(ctx.f)).toHaveLength(1);
    } else {
      await expectHeld(ctx, lines, 1);
      expect(lines[0]).toContain(`native process ${ctx.native.pid} is still present`);
    }
  },
);

test.each(["unavailable", "replaced foreground"] as const)(
  "bare-shell recovery holds after %s during exit proof",
  async (condition) => {
    const ctx = await readyHeld(true);
    let intercepted = false;
    const deps: FlowDeps = {
      ...ctx.f.deps,
      run: async (argv, options) => {
        if (!intercepted && argv[0] === "ps" && argv[1] === "-A" && argv.includes("pid=")) {
          intercepted = true;
          if (condition === "unavailable") return { code: 1, out: "", err: "process table unavailable" };
          const pane = ctx.f.world.panes.find((entry) => entry.pane_id === ctx.ref.id);
          const shell = ctx.f.world.shells?.[ctx.ref.id];
          if (!pane || shell === undefined) throw new Error("initial shell is absent");
          const script = { name: "bash", argv: ["bash", "owner-script.sh"], pid: 9000 };
          pane.foreground = [script];
          ctx.f.world.procs?.push({ pid: script.pid, ppid: shell, cmd: script.argv.join(" ") });
        }
        return ctx.f.deps.run(argv, options);
      },
    };
    await expectHeld(ctx, await watchTick(deps), 1);
    expect(intercepted).toBe(true);
  },
);
