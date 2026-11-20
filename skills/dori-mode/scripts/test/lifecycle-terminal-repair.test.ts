import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { closeLane, type FlowDeps } from "../src/done-flow.ts";
import { readPaneState } from "../src/lane-state.ts";
import { parkLane } from "../src/park.ts";
import { sessionFields, sessionOf, statusOf, withStatus } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import { runtimesOf } from "../src/run.ts";
import { checkDone } from "../src/signals.ts";
import { syncRegistry } from "../src/sync.ts";
import { hcSent, laneState, sent } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

const boundLane = () => ({ ...f.lane, session: f.session, sessionFile: f.file });
const clearBinding = () => {
  const { session: _session, sessionFile: _file, ...lane } = f.lane;
  return lane;
};
const herdrCloses = () =>
  f.world.calls.filter(
    ([cmd, scope, verb]) => cmd === "herdr" && (scope === "pane" || scope === "tab") && verb === "close",
  );
const registeredStatus = async () => {
  const lane = await f.deps.registry.read(f.lane.key);
  return lane && statusOf(lane);
};

// Model the actual damage of a tab close in the fake world, including the sibling.
const withSibling = (deps: FlowDeps, pane: string, tab: string): FlowDeps => {
  f.world.panes = f.world.panes.map((p) => (p.pane_id === pane ? { ...p, tab_id: tab } : p));
  const sibling = { pane_id: "w1:p9", workspace_id: "w1", tab_id: tab, foreground: "bash" };
  f.world.panes.push(sibling);
  return {
    ...deps,
    run: async (argv, options) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "close" && argv[3] === tab) {
        f.world.panes = f.world.panes.filter((p) => p.pane_id !== pane && p.pane_id !== sibling.pane_id);
      }
      return deps.run(argv, options);
    },
  };
};

for (const occupant of ["foreign session", "pending approval"] as const) {
  test(`ordinary close holds an unverified reopen with ${occupant} despite passing Done`, async () => {
    const lane = { ...boundLane(), thread: "discord:123", worktrees: [`${f.deps.config.defaultCwd}/worktree`] };
    await f.deps.registry.write(lane);
    const parked = await parkLane(f.deps, lane, "wait");
    expect(parked.code).toBe(0);
    if (occupant === "foreign session") f.foreign();
    const deps: FlowDeps = {
      ...f.deps,
      config: { ...f.deps.config, hooks: { ...f.deps.config.hooks, threadDone: ["notify", "{thread}"] } },
      run: async (argv, options) => {
        const result = await f.deps.run(argv, options);
        if (occupant === "pending approval" && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
          const state = readPaneState(f.state.dir, "w1:p8")!;
          laneState(f.state.dir, "w1:p8", { ...state, approvalPending: true });
        }
        return result;
      },
    };
    const reopened = await reopenLane(deps, parked.lane);
    expect(reopened.code).toBe(3);
    expect(reopened.lines[0]).toContain("REOPEN_UNVERIFIED");
    expect(await registeredStatus()).toBe("paused");
    expect(await runtimesOf(deps).default.probe(sessionOf(reopened.lane)!)).toMatchObject(
      occupant === "foreign session" ? { sessionId: "foreign" } : { sessionId: f.session, approvalPending: true },
    );
    expect(await checkDone(lane.done, deps.run, { cwd: deps.config.defaultCwd })).toEqual([
      expect.objectContaining({ ok: true }),
    ]);
    const closeDeps = withSibling(deps, "w1:p8", "w1:t8");
    f.world.calls.length = 0;
    const result = await closeLane(closeDeps, reopened.lane, "verified Done");
    expect({
      closed: result.closed,
      status: await registeredStatus(),
      closes: herdrCloses(),
      livePanes: f.world.panes.map((p) => p.pane_id),
      cleanup: f.world.calls.filter(
        ([cmd, , , noun, verb]) => cmd === "notify" || (cmd === "git" && noun === "worktree" && verb === "remove"),
      ),
    }).toEqual({ closed: false, status: "paused", closes: [], livePanes: ["w1:p8", "w1:p9"], cleanup: [] });
  });
}

test("write sync reports a foreign reopen occupant without replacing the saved session", async () => {
  const lane = boundLane();
  await f.deps.registry.write(lane);
  const parked = await parkLane(f.deps, lane, "wait");
  expect(parked.code).toBe(0);
  f.foreign();
  const reopened = await reopenLane(f.deps, parked.lane);
  expect(reopened.code).toBe(3);
  const synced = await syncRegistry(f.deps, true);
  expect(synced.drift.join("\n")).toContain("pane now runs session foreign");
  expect(await f.deps.registry.read(lane.key)).toMatchObject({
    session: f.session,
    sessionFile: f.file,
    status: "paused",
  });
});

test("ordinary close of the exact native session removes only its recorded pane", async () => {
  const lane = boundLane();
  await f.deps.registry.write(lane);
  const parked = await parkLane(f.deps, lane, "wait");
  expect(parked.code).toBe(0);
  const reopened = await reopenLane(f.deps, parked.lane);
  expect(reopened.code).toBe(0);
  f.world.calls.length = 0;
  const deps = withSibling(f.deps, "w1:p8", "w1:t8");
  expect(await runtimesOf(deps).default.probe(sessionOf(reopened.lane)!)).toMatchObject({
    status: "idle",
    sessionId: f.session,
  });
  const result = await closeLane(deps, reopened.lane, "verified Done");
  expect({
    closed: result.closed,
    status: await registeredStatus(),
    closes: herdrCloses(),
    livePanes: f.world.panes.map((p) => p.pane_id),
  }).toEqual({ closed: true, status: "closed", closes: [["herdr", "pane", "close", "w1:p8"]], livePanes: ["w1:p9"] });
});

for (const [command, outcome] of [
  ["park", "parked"],
  ["abandon", "abandoned"],
] as const) {
  test(`${command} holds a switched OMP session without a prior binding before sending goal input`, async () => {
    const session = "01a11440-ee81-7f90-b2ed-dcc7d51a0ade";
    const sessionFile = f.file.replace(f.session, session);
    const cwd = f.deps.config.defaultCwd;
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: session, cwd })}\n`);
    laneState(f.state.dir, "w1:p7", { cwd, sessionId: session, sessionFile });
    const lane = clearBinding();
    await f.deps.registry.write(lane);
    expect((await f.deps.registry.read(f.lane.key))?.session).toBeUndefined();
    expect(await runtimesOf(f.deps).default.probe(sessionOf(f.lane)!)).toMatchObject({
      status: "idle",
      sessionId: session,
    });
    const result = await parkLane(f.deps, lane, "operator hold", outcome);
    expect({
      code: result.code,
      status: await registeredStatus(),
      input: sent(f.world),
      closes: herdrCloses(),
      livePanes: f.world.panes.map((p) => p.pane_id),
    }).toEqual({ code: 3, status: "working", input: [], closes: [], livePanes: ["w1:p7"] });
  });
}

test("abandon closes a confirmed bare Herdr shell without a prior session binding", async () => {
  const lane = clearBinding();
  await f.deps.registry.write(lane);
  f.world.panes = [{ pane_id: "w1:p7", workspace_id: "w1", foreground: "bash" }];
  f.world.procs = [];
  const ref = sessionOf(f.lane)!;
  expect(await runtimesOf(f.deps).for(ref).probe(ref)).toMatchObject({
    shellInFront: true,
    foreground: [{ name: "bash", argv: ["bash"] }],
  });
  const result = await parkLane(f.deps, lane, "agent gone", "abandoned");
  expect(result.code).toBe(0);
  expect(await registeredStatus()).toBe("closed");
  expect(sent(f.world)).toEqual([]);
  expect(herdrCloses()).toEqual([["herdr", "pane", "close", "w1:p7"]]);
  expect(f.world.panes).toEqual([]);
});

for (const foreground of ["bare shell", "shell running a script"] as const) {
  test(`abandon after failed hc reopen handles a statusless ${foreground}`, async () => {
    f.world.panes = [];
    f.world.procs = [];
    const deps: FlowDeps = {
      ...f.deps,
      config: { ...f.deps.config, runtime: "hc" },
      run: async (argv, options) => {
        if (argv[0] === "hc" && argv[2] === "send" && argv.at(-1)?.includes("--resume=")) {
          return { code: 1, out: "", err: "agent start failed" };
        }
        return f.deps.run(argv, options);
      },
    };
    const closed = withStatus(boundLane(), "closed", "parked earlier", "2026-01-01T12:30:00.000Z", {
      ...sessionFields({ runtime: "hc", id: "t7" }),
      closedAt: "2026-01-01T12:30:00.000Z",
    });
    await deps.registry.write(closed);
    const reopened = await reopenLane(deps, closed);
    expect(reopened.code).toBe(3);
    expect(reopened.lines[0]).toContain("start failed");
    expect(await registeredStatus()).toBe("paused");
    const ref = sessionOf(reopened.lane)!;
    const sibling = hcTerm({ status: null, foreground: { name: "zsh", argv: ["zsh"], pid: 951 } });
    f.world.terminals["t9"] = sibling;
    const bare = foreground === "bare shell";
    const argv = bare ? ["zsh"] : ["zsh", "owner-script.sh"];
    f.world.terminals[ref.id]!.foreground = { name: "zsh", argv, pid: 950 };
    const runtime = runtimesOf(deps).for(ref);
    const listed = await runtime.list();
    expect(listed.find((entry) => entry.ref.id === ref.id)).toBeDefined();
    expect(listed.find((entry) => entry.ref.id === ref.id)?.status).toBeUndefined();
    const probe = await runtime.probe(ref);
    expect(probe).toMatchObject({ status: "shell", shellInFront: true, foreground: [{ name: "zsh", argv }] });
    expect(probe.pid).toBeUndefined();
    f.world.calls.length = 0;
    const result = await parkLane(deps, reopened.lane, "startup failed", "abandoned");
    expect({
      code: result.code,
      status: await registeredStatus(),
      input: hcSent(f.world),
      closes: f.world.calls.filter(([cmd, , verb]) => cmd === "hc" && (verb === "kill" || verb === "rm")),
      remaining: (await runtime.list()).map((entry) => entry.ref.id),
    }).toEqual({
      code: bare ? 0 : 3,
      status: bare ? "closed" : "paused",
      input: [],
      closes: bare
        ? [
            ["hc", "--json", "kill", ref.id],
            ["hc", "--json", "rm", ref.id],
          ]
        : [],
      remaining: bare ? ["t9"] : [ref.id, "t9"],
    });
  });
}
