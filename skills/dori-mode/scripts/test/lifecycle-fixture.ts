import { expect } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import { readPaneState } from "../src/lane-state.ts";
import { parkLane } from "../src/park.ts";
import { sessionOf, upgradeLane, withStatus, type Lane } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState, type TestState, type World } from "./fakes.ts";

export type LifecycleFixture = {
  state: TestState;
  world: World;
  deps: FlowDeps;
  lane: Lane;
  file: string;
  session: string;
  creates: () => number;
  failClose: () => void;
  keepProcessAlive: () => void;
  failStart: (value?: boolean) => void;
  foreign: () => void;
};

export const lifecycleFixture = async (): Promise<LifecycleFixture> => {
  const state = withState();
  const world = newWorld();
  const cwd = join(state.dir, "repo");
  mkdirSync(cwd);
  const sessionsDir = join(state.dir, "sessions-store");
  const session = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
  const dir = sessionDirFor(sessionsDir, cwd);
  mkdirSync(dir, { recursive: true });
  // Lifecycle receipts and resume commands use canonical transcript paths, even under a symlinked TMPDIR.
  const file = join(realpathSync(dir), `2026-01-01T12-00-00-000Z_${session}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id: session, cwd })}\n`);
  const lane: Lane = {
    key: "lifecycle-lane",
    title: "lifecycle",
    thread: "none",
    pane: "w1:p7",
    tab: "w1:t7",
    brief: join(state.dir, "brief.md"),
    cwd,
    session,
    sessionFile: file,
    done: "merged acme/app#1",
    openedAt: "2026-01-01T12:00:00.000Z",
  };
  const attach = (pane: string, goal: "active" | "paused", pid: number) => {
    world.panes = world.panes.filter((p) => p.pane_id !== pane);
    world.panes.push({
      pane_id: pane,
      workspace_id: "w1",
      tab_id: pane === "w1:p7" ? "w1:t7" : "w1:t8",
      agent: "omp",
      agent_status: "idle",
    });
    agentIn(world, pane, pid);
    laneState(state.dir, pane, { cwd, pid, sessionFile: file, goal: { status: goal } });
  };
  attach("w1:p7", "active", 4242);
  world.onSendText = (id, text) => {
    const current = readPaneState(state.dir, id);
    if (current && (text === "/goal pause" || text === "/goal resume"))
      laneState(state.dir, id, { ...current, goal: { status: text === "/goal pause" ? "paused" : "active" } });
  };
  let createCount = 0;
  let closeFails = false;
  let processLingers = false;
  let startFails = false;
  let wrongSession = false;
  const clock = {
    ...fakeClock(Date.parse("2026-01-01T13:00:00.000Z")),
    // Concurrent lock waiters must yield to the real session-file stream, not spin in resolved microtasks.
    sleep: async () => {
      await Bun.sleep(1);
    },
  };
  const base = depsFor(world, clock, state.dir, { sessionsDir, defaultCwd: cwd, startupWaitSeconds: 1 });
  const deps: FlowDeps = {
    ...base,
    env: { DORI_CONFIG: join(state.dir, "config.json") },
    run: async (argv, options) => {
      if (argv[0] === "herdr" && (argv[1] === "pane" || argv[1] === "tab") && argv[2] === "close") {
        world.calls.push([...argv]);
        if (closeFails) return { code: 1, out: "", err: "close refused" };
        const closed = world.panes.filter((p) => (argv[1] === "pane" ? p.pane_id : p.tab_id) === argv[3]);
        const pids = closed.map((p) => readPaneState(state.dir, p.pane_id)?.pid);
        world.panes = world.panes.filter((p) => !closed.includes(p));
        if (!processLingers && world.procs) world.procs = world.procs.filter((p) => !pids.includes(p.pid));
        return { code: 0, out: "{}", err: "" };
      }
      if (argv[0] === "hc" && argv[2] === "kill") {
        const pid = readPaneState(state.dir, argv[3] ?? "")?.pid;
        const result = await base.run(argv, options);
        if (result.code === 0 && !processLingers && world.procs) world.procs = world.procs.filter((p) => p.pid !== pid);
        return result;
      }
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
        world.calls.push([...argv]);
        createCount++;
        world.panes.push({ pane_id: "w1:p8", workspace_id: "w1", foreground: "bash" });
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p8", workspace_id: "w1", tab_id: "w1:t8" } } }),
          err: "",
        };
      }
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
        if (startFails) return { code: 1, out: "", err: "agent start failed" };
        attach("w1:p8", "paused", 4250);
        if (wrongSession)
          laneState(state.dir, "w1:p8", { cwd, pid: 4250, sessionId: "foreign", goal: { status: "paused" } });
      }
      return base.run(argv, options);
    },
  };
  await deps.registry.write(lane);
  return {
    state,
    world,
    deps,
    lane,
    file,
    session,
    creates: () => createCount,
    failClose: () => {
      closeFails = true;
    },
    keepProcessAlive: () => {
      processLingers = true;
    },
    failStart: (value = true) => {
      startFails = value;
    },
    foreign: () => {
      wrongSession = true;
    },
  };
};

export const closeFixture = async (f: LifecycleFixture, agentStatus: "idle" | "working" = "idle", reopen = true) => {
  let lane = upgradeLane(f.lane);
  if (reopen) {
    const parked = await parkLane(f.deps, lane, "fixture pause");
    expect(parked.code).toBe(0);
    const reopened = await reopenLane(f.deps, parked.lane);
    expect(reopened.code).toBe(0);
    lane = reopened.lane;
  }
  const ref = sessionOf(lane);
  expect(ref).toBeDefined();
  if (!ref) throw new Error("reopened native reference is absent");
  const native = readPaneState(f.state.dir, ref.id);
  expect(native).not.toBeNull();
  if (!native) throw new Error("reopened native identity is absent");
  laneState(f.state.dir, ref.id, { ...native, goal: { status: "none" }, agentStatus });
  const at = new Date(f.deps.clock.now() - 3_600_000).toISOString();
  const worktree = join(f.state.dir, "owned-worktree");
  const claim = withStatus(lane, "done-claimed", "Done signal is live", at, {
    claim: { at, evidence: "Done signal is live", emitted: true },
    worktrees: [worktree],
  });
  await f.deps.registry.write(claim);
  f.world.calls.length = 0;
  return { f, ref, native, claim, worktree };
};

export type CloseFixture = Awaited<ReturnType<typeof closeFixture>>;
export const closes = (f: LifecycleFixture) =>
  f.world.calls.filter(([cmd, , verb]) => cmd === "herdr" && verb === "close");
export const removals = (f: LifecycleFixture) =>
  f.world.calls.filter(([cmd, , , kind, verb]) => cmd === "git" && kind === "worktree" && verb === "remove");
export const paneGone = ({ f, ref }: CloseFixture) => !f.world.panes.some((pane) => pane.pane_id === ref.id);

export const expectHeld = async (ctx: CloseFixture, lines: readonly string[], closeCount: number) => {
  const lane = await ctx.f.deps.registry.read(ctx.claim.key);
  expect(lines).toEqual([expect.stringContaining(`LANE_HELD ${ctx.claim.key}`)]);
  expect(lane?.status).toBe("done-claimed");
  expect(lane?.receipt).toBeUndefined();
  expect(closes(ctx.f)).toHaveLength(closeCount);
  expect(removals(ctx.f)).toHaveLength(0);
  return lane;
};

export const intentOf = async (ctx: CloseFixture) => {
  const lane = await ctx.f.deps.registry.read(ctx.claim.key);
  const intent = lane?.nativeCloseIntent;
  if (!intent?.process) throw new Error("prepared process proof is absent");
  expect(intent).toMatchObject({
    ref: ctx.ref,
    session: ctx.claim.session,
    epoch: ctx.claim.lifecycleEpoch,
    openedAt: ctx.claim.openedAt,
    process: { pid: ctx.native.pid, startTicks: String(ctx.native.pid), bootId: "fixture-boot" },
  });
  return { ...intent, process: intent.process };
};

export const expectClosed = async (ctx: CloseFixture, lines: readonly string[]) => {
  const lane = await ctx.f.deps.registry.read(ctx.claim.key);
  expect(lines).toEqual([`LANE_CLOSED ${ctx.claim.key} ${JSON.stringify(lane?.receipt)}`]);
  expect(lane).toMatchObject({
    status: "closed",
    receipt: { outcome: "done", cleanup: [`pane ${ctx.ref.id} closed`, `worktree ${ctx.worktree} removed`] },
  });
  expect(lane?.nativeCloseIntent).toBeUndefined();
  expect(closes(ctx.f)).toHaveLength(1);
  expect(removals(ctx.f)).toHaveLength(1);
};

export const failFirstClose = (ctx: CloseFixture): FlowDeps => {
  let failed = false;
  return {
    ...ctx.f.deps,
    run: async (argv, options) => {
      if (!failed && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "close") {
        failed = true;
        ctx.f.world.calls.push([...argv]);
        return { code: 1, out: "", err: "close refused" };
      }
      return ctx.f.deps.run(argv, options);
    },
  };
};

export const removeProcess = (ctx: CloseFixture, pid: number) => {
  if (ctx.f.world.procs) ctx.f.world.procs = ctx.f.world.procs.filter((process) => process.pid !== pid);
};
