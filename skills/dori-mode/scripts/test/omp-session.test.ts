import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { runtimesFor, runtimesOf } from "../src/run.ts";
import { resolveSession, sessionDirFor, trustedPaneState } from "../src/session-id.ts";
import { sendVerified } from "../src/sessions.ts";
import { syncRegistry } from "../src/sync.ts";
import {
  agentIn,
  depsFor,
  fakeClock,
  hcSent,
  laneState,
  newWorld,
  sent,
  withState,
  type TestState,
  type World,
} from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const P1 = { runtime: "herdr", id: "w:p1" } as const;
const T1 = { runtime: "hc", id: "t1" } as const;
let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const setup = (hc = false) => {
  if (hc) {
    world.terminals = {
      t1: hcTerm({
        pid: 4242,
        status: { state: "idle", app: "omp" },
        foreground: { name: "omp", argv: ["omp"], pid: 4242 },
      }),
    };
    world.procs = [{ pid: 4242, ppid: 1, cmd: "bun /opt/bin/omp --dori-role lane" }];
  } else {
    world.panes = [{ pane_id: P1.id, workspace_id: "w", agent: "omp", agent_status: "idle", cwd: "/repo" }];
    agentIn(world, P1.id);
  }
  const ref = hc ? T1 : P1;
  laneState(state.dir, ref.id);
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime: hc ? "hc" : "herdr" });
  return { deps, ref, rts: runtimesOf(deps) };
};

test("current extension identity wins on herdr and on an hc direct-program root", async () => {
  for (const hc of [false, true]) {
    const { deps, ref, rts } = setup(hc);
    const agent = world.procs?.find((p) => p.pid === 4242);
    if (agent) agent.cmd += " --resume old-session-file";
    const hit = await resolveSession(ref, "/repo", world.procs ?? [], {
      run: deps.run,
      rts,
      stateDir: state.dir,
      sessionsDir: "/s",
    });
    expect(hit).toEqual({ id: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf", via: "extension", pid: 4242 });
    expect((await trustedPaneState(deps.run, state.dir, ref, rts))?.pid).toBe(4242);
  }
});

test("an explicit runtime environment keeps the current lane isolated from an inherited herdr namespace", async () => {
  const inherited = process.env["DORI_HERDR_SESSION"];
  try {
    process.env["DORI_HERDR_SESSION"] = "foreign-controller";
    const { deps, ref, rts } = setup();
    expect((await trustedPaneState(deps.run, state.dir, ref, rts))?.sessionId).toBe(
      "01a11440-ee81-7f90-b2ed-dcc7d51a0adf",
    );
    world.onEnterStatus = "working";
    expect(await sendVerified(rts, deps.clock, ref, "[LEAD] report")).toBe("delivered");
  } finally {
    if (inherited === undefined) delete process.env["DORI_HERDR_SESSION"];
    else process.env["DORI_HERDR_SESSION"] = inherited;
  }
});

test("an exited, foreign or non-agent writer never supplies the current session id", async () => {
  const { deps, ref, rts } = setup();
  const listDir = (dir: string) =>
    dir === "/s/--repo--" ? ["2026-01-01T12-00-02-113Z_01a10000-0000-7000-8000-000000000000.jsonl"] : [];
  const run = async (argv: readonly string[]) =>
    argv[0] === "ps" && argv.includes("lstart=")
      ? { code: 0, out: "Thu Jan  1 12:00:01 2026 GMT", err: "" }
      : deps.run(argv);
  for (const outside of [[], [{ pid: 77, ppid: 1, cmd: "omp" }], [{ pid: 77, ppid: 4242, cmd: "cat log" }]]) {
    laneState(state.dir, ref.id, { pid: 77 });
    const table = [...(world.procs ?? []), ...outside];
    const hit = await resolveSession(ref, "/repo", table, {
      run,
      rts,
      stateDir: state.dir,
      sessionsDir: "/s",
      listDir,
    });
    expect(hit).toEqual({ id: "01a10000-0000-7000-8000-000000000000", via: "start-time", pid: 4242 });
  }
  laneState(state.dir, ref.id, { paneId: "w:other" });
  expect(await trustedPaneState(deps.run, state.dir, ref, rts)).toBeNull();
});

test("PID reuse and a different foreground agent invalidate state; a suspended writer remains readable but gets no input", async () => {
  const { deps, ref } = setup();
  const run = async (argv: readonly string[]) =>
    argv[0] === "ps" && argv.includes("lstart=")
      ? { code: 0, out: "Thu Jan  1 12:05:00 2026 GMT", err: "" }
      : deps.run(argv);
  const rts = runtimesFor(deps.config, {}, run, deps.clock);
  expect(await trustedPaneState(run, state.dir, ref, rts)).toBeNull();
  if (world.panes[0]) world.panes[0].foreground = [{ name: "other-agent", argv: ["other-agent"], pid: 7000 }];
  world.procs?.push({ pid: 7000, ppid: 4241, cmd: "other-agent" });
  expect(await trustedPaneState(deps.run, state.dir, ref, runtimesOf(deps))).toBeNull();
  if (world.panes[0]) world.panes[0].foreground = "zsh";
  expect((await trustedPaneState(deps.run, state.dir, ref, runtimesOf(deps)))?.pid).toBe(4242);
  expect(await sendVerified(runtimesOf(deps), deps.clock, ref, "[LEAD] report")).toBe("failed");
});

test("OMP start-time fallback uses OMP encoding and ignores legacy --session and child environment guesses", async () => {
  const { deps, ref, rts } = setup();
  const table = [
    { pid: 4241, ppid: 1, cmd: "zsh" },
    { pid: 4242, ppid: 4241, cmd: "bun /opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js --session old-id" },
    { pid: 4243, ppid: 4242, cmd: "bun mcp" },
  ];
  laneState(state.dir, ref.id, { pid: 99 });
  const run = async (argv: readonly string[]) =>
    argv[0] === "ps" && argv.includes("lstart=")
      ? { code: 0, out: "Thu Jan  1 12:00:01 2026 GMT", err: "" }
      : deps.run(argv);
  const hit = await resolveSession(ref, "/nohome/me/dev/project", table, {
    run,
    rts,
    stateDir: state.dir,
    sessionsDir: "/s",
    listDir: (dir) =>
      dir === sessionDirFor("/s", "/nohome/me/dev/project")
        ? ["2026-01-01T12-00-02-113Z_01a10000-0000-7000-8000-000000000000.jsonl"]
        : [],
  });
  expect(hit.via).toBe("start-time");
  expect(hit.id).toBe("01a10000-0000-7000-8000-000000000000");
  expect(world.calls.some((argv) => argv.includes("eww"))).toBe(false);
  expect(
    await resolveSession(
      ref,
      "/repo",
      table.filter((p) => p.pid !== 4242),
      {
        run,
        rts,
        stateDir: state.dir,
        sessionsDir: "/s",
      },
    ),
  ).toEqual({ id: "", via: "none" });
});

test("OMP session folders canonicalize temp before home and keep absolute paths outside both", () => {
  const dir = (cwd: string) => sessionDirFor("/s", cwd, "/nohome/me", "/nohome/me/tmp");
  expect(dir("/nohome/me/tmp")).toBe("/s/-tmp");
  expect(dir("/nohome/me/tmp/build/x")).toBe("/s/-tmp-build-x");
  expect(dir("/nohome/me")).toBe("/s/-");
  expect(dir("/nohome/me/dev/project")).toBe("/s/-dev-project");
  expect(dir("/nohome/meow/x")).toBe("/s/--nohome-meow-x--");
  expect(dir("/nohome/me/dev/../dev/a:b")).toBe("/s/-dev-a-b");
  const real = join(state.dir, "real");
  mkdirSync(real);
  symlinkSync(real, join(state.dir, "alias"));
  expect(sessionDirFor("/s", join(state.dir, "alias"))).toBe(sessionDirFor("/s", real));
});

test("trusted approval holds stop typing on both runtimes and clearing the hold permits one delivery", async () => {
  for (const hc of [false, true]) {
    const { deps, ref, rts } = setup(hc);
    world.calls = [];
    laneState(state.dir, ref.id, { approvalPending: true });
    expect(await sendVerified(rts, deps.clock, ref, "[LEAD] report")).toBe("failed");
    expect(hc ? hcSent(world) : sent(world)).toEqual([]);
    laneState(state.dir, ref.id, { approvalPending: false });
    world.onEnterStatus = "working";
    expect(await sendVerified(rts, deps.clock, ref, "[LEAD] report")).toBe("delivered");
    expect(hc ? hcSent(world) : sent(world)).toEqual(["[LEAD] report"]);
  }
});

test("sync reads legacy registry records without mutation and persists trusted extension identity only with --write", async () => {
  const { deps } = setup();
  const lane = {
    key: "omp-lane",
    title: "omp",
    thread: "none",
    pane: P1.id,
    brief: "/b.md",
    done: "closed acme/app#1",
    openedAt: new Date(T0).toISOString(),
  };
  await deps.registry.write(lane);
  expect((await syncRegistry(deps, false)).rows[0]?.session).toContain("(extension)");
  expect((await deps.registry.read(lane.key))?.session).toBeUndefined();
  await syncRegistry(deps, true);
  expect(await deps.registry.read(lane.key)).toMatchObject({
    sessionRef: P1,
    session: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf",
    sessionVia: "extension",
  });
});
