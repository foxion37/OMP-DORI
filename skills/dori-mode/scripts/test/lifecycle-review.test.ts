import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { closeLane } from "../src/done-flow.ts";
import { parkLane } from "../src/park.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { reopenLane } from "../src/reopen.ts";
import { Reports } from "../src/reports.ts";
import { Supervision } from "../src/supervision.ts";
import { laneState, sent } from "./fakes.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

test.each(["done", "halted", "blocker", "question"] as const)(
  "reopen resets old %s progress without dropping report history",
  async (kind) => {
    const reports = new Reports(f.state.dir);
    reports.report(f.lane.key, kind, "previous lifecycle", f.deps.clock.now());
    const parked = await parkLane(f.deps, f.lane, "wait");
    const reopened = await reopenLane(f.deps, parked.lane);
    expect(reopened.code).toBe(0);
    expect(reports.read(f.lane.key)?.state).toBe("running");
    expect(reports.read(f.lane.key)?.lastReport).toBeNull();
    expect(await Bun.file(reports.path(f.lane.key)).text()).toContain("previous lifecycle");
    const supervision = new Supervision({ ...f.deps, stateDir: f.state.dir }, { defaults: { wallMinutes: 0 } });
    expect((await supervision.sweep(reopened.lane, "idle")).alerts).toContain("wallMinutes ceiling reached (0)");
  },
);

test("a reopened lifecycle records a new final cost exactly once", async () => {
  const reports = new Reports(f.state.dir);
  reports.report(f.lane.key, "done", "old completion", f.deps.clock.now());
  let measurements = 0;
  let receipts = 0;
  const supervisor = new Supervision(
    {
      ...f.deps,
      stateDir: f.state.dir,
      run: async (argv) => {
        if (argv[0] === "usage")
          return { code: 0, out: JSON.stringify({ tokens: ++measurements, costUsd: measurements }), err: "" };
        if (argv[0] === "record") {
          receipts++;
          return { code: 0, out: "", err: "" };
        }
        return f.deps.run(argv);
      },
    },
    { usageArgv: ["usage"], recordCostArgv: ["record", "{closeKey}"] },
  );
  await supervisor.close(f.lane);
  const parked = await parkLane(f.deps, f.lane, "wait");
  const reopened = await reopenLane(f.deps, parked.lane);
  await supervisor.close(reopened.lane);
  await supervisor.close(reopened.lane);
  expect(measurements).toBe(2);
  expect(receipts).toBe(2);
});

test("ordinary resume cannot wake the foreign session from an unconfirmed reopen", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  f.foreign();
  const failed = await reopenLane(f.deps, parked.lane);
  expect(failed.code).toBe(3);
  expect((await resumeLane(f.deps, failed.lane, "retry resume")).code).toBe(3);
  expect(sent(f.world)).toEqual(["/goal pause"]);
});

test("normal close keeps its delivery lock through worktree cleanup", async () => {
  let lockDuringCleanup = false;
  const lane = { ...f.lane, worktrees: [f.deps.config.defaultCwd] };
  await f.deps.registry.write(lane);
  const result = await closeLane(
    {
      ...f.deps,
      run: async (argv) => {
        if (argv[0] === "git" && argv.includes("remove"))
          lockDuringCleanup = existsSync(join(f.deps.registry.dir, `${lane.key}.deliver.lock`));
        return f.deps.run(argv);
      },
    },
    lane,
    "done",
  );
  expect(result.closed).toBe(true);
  expect(lockDuringCleanup).toBe(true);
  expect(existsSync(join(f.deps.registry.dir, `${lane.key}.deliver.lock`))).toBe(false);
});

test("a failed reopen can be explicitly abandoned from its shell, then reopened safely", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  f.failStart();
  const failed = await reopenLane(f.deps, parked.lane);
  expect(failed.code).toBe(3);
  const abandoned = await parkLane(f.deps, failed.lane, "startup failed", "abandoned");
  expect(abandoned.code).toBe(0);
  expect(sent(f.world)).toEqual(["/goal pause"]);
  f.failStart(false);
  expect((await reopenLane(f.deps, abandoned.lane)).code).toBe(0);
});

test("an unreadable peer probe holds reopen without creating a pane", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  f.world.panes.push({ pane_id: "w1:p9", workspace_id: "w1", foreground: "bash" });
  const result = await reopenLane(
    {
      ...f.deps,
      run: async (argv) => {
        if (argv[2] === "get" && argv[3] === "w1:p9") return { code: 1, out: "", err: "transport unavailable" };
        return f.deps.run(argv);
      },
    },
    parked.lane,
  );
  expect(result.code).toBe(3);
  expect(result.lines[0]).toContain("cannot inspect session");
  expect(f.creates()).toBe(0);
});

test.each(["slash", "symlink"])("pause and reopen accept equivalent %s working directories", async (form) => {
  const cwd = form === "slash" ? `${f.lane.cwd}/` : join(f.state.dir, "repo-alias");
  if (form === "symlink") symlinkSync(f.lane.cwd!, cwd, "dir");
  const lane = { ...f.lane, cwd, session: f.session };
  await f.deps.registry.write(lane);
  const parked = await parkLane(f.deps, lane, "waiting");
  expect(parked.code).toBe(0);
  expect((await reopenLane(f.deps, parked.lane)).code).toBe(0);
});

test("an unavailable identity cwd holds pause before sending input", async () => {
  const lane = { ...f.lane, cwd: join(f.state.dir, "not-present"), session: f.session };
  await f.deps.registry.write(lane);
  const result = await pauseLane(f.deps, lane, "wait");
  expect(result.code).toBe(3);
  expect(result.lines[0]).toContain("identity unverified before send");
  expect(sent(f.world)).toEqual([]);
});

test("ordinary resume after failed reopen readback still resets old terminal reports once", async () => {
  const reports = new Reports(f.state.dir);
  reports.report(f.lane.key, "done", "previous completion", f.deps.clock.now());
  const parked = await parkLane(f.deps, f.lane, "wait");
  const state = { cwd: f.lane.cwd!, pid: 4250, sessionId: f.session, goal: { status: "paused" as const } };
  const failed = await reopenLane(
    {
      ...f.deps,
      run: async (argv) => {
        const result = await f.deps.run(argv);
        if (argv[1] === "pane" && argv[2] === "run")
          laneState(f.state.dir, "w1:p8", { ...state, approvalPending: true });
        return result;
      },
    },
    parked.lane,
  );
  expect(failed.code).toBe(3);
  laneState(f.state.dir, "w1:p8", state);
  expect((await resumeLane(f.deps, failed.lane, "approval resolved")).code).toBe(0);
  expect(reports.read(f.lane.key)?.state).toBe("running");
  expect(reports.read(f.lane.key)?.lastReport).toBeNull();
  expect((await Bun.file(reports.path(f.lane.key)).text()).match(/"type":"reopen"/g)).toHaveLength(1);
});

test("a failed shell probe holds abandonment without closing or sending input", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  f.failStart();
  const failed = await reopenLane(f.deps, parked.lane);
  const result = await parkLane(
    {
      ...f.deps,
      run: async (argv) => {
        if (argv[2] === "get" && argv[3] === "w1:p8") return { code: 1, out: "", err: "transport unavailable" };
        return f.deps.run(argv);
      },
    },
    failed.lane,
    "startup failed",
    "abandoned",
  );
  expect(result.code).toBe(3);
  expect(result.lines[0]).toContain("ABANDON_UNVERIFIED");
  expect(f.world.panes.some((pane) => pane.pane_id === "w1:p8")).toBe(true);
  expect(sent(f.world)).toEqual(["/goal pause"]);
});
