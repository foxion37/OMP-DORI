import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import { ScheduleStore } from "../src/schedule-store.ts";
import { observeSystemd } from "../src/schedule-systemd.ts";
import { scheduleBoot, scheduleView } from "../src/schedule-view.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
let state: ReturnType<typeof withState>;
const now = Date.parse("2026-11-19T00:00:00Z");
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const timer = { name: "backup", unit: "backup.timer", system: false };

test("adopted timers are observed with show only, including their actual triggered service result", async () => {
  const calls: readonly string[][] = [];
  const run: Runner = async (argv, options) => {
    (calls as string[][]).push([...argv]);
    expect(options?.timeoutMs).toBe(10_000);
    return {
      code: 0,
      err: "",
      out:
        argv.at(-1) === "backup.timer"
          ? "LoadState=loaded\nActiveState=active\nUnit=backup.service\nNextElapseUSecRealtime=Fri 2026-11-20 00:00:00 UTC\nLastTriggerUSec=Thu 2026-11-19 00:00:00 UTC"
          : "LoadState=loaded\nActiveState=inactive\nExecMainStartTimestamp=Thu 2026-11-19 00:00:00 UTC\nExecMainExitTimestamp=Thu 2026-11-19 00:00:01 UTC\nExecMainStartTimestampMonotonic=1000000\nExecMainExitTimestampMonotonic=2000000\nExecMainStatus=7\nResult=exit-code",
    };
  };
  const store = new ScheduleStore(state.dir);
  await store.adopt(timer);
  const before = readFileSync(store.path, "utf8");
  const view = await scheduleView(store, run, now);
  expect(view.adopted[0]).toMatchObject({
    readOnly: true,
    missed: "systemd-managed",
    next: "Fri 2026-11-20 00:00:00 UTC",
    lastExit: { code: 7, result: "exit-code" },
  });
  expect(calls).toHaveLength(2);
  expect(
    calls.every((argv) => argv.slice(0, 7).join(" ") === "env LC_ALL=C TZ=UTC systemctl --user show --no-pager"),
  ).toBe(true);
  await expect(store.pause("backup", true, now)).rejects.toThrow("read-only");
  expect(readFileSync(store.path, "utf8")).toBe(before);
  await store.remove("backup");
  expect(calls).toHaveLength(2);
});

test("never-started services do not invent a zero exit or a missed count", async () => {
  const result = await observeSystemd(
    { ...timer, unit: "backup.service", system: true },
    async (argv) => {
      expect(argv).toContain("--system");
      return {
        code: 0,
        err: "",
        out: "LoadState=loaded\nActiveState=inactive\nExecMainStartTimestamp=\nExecMainStatus=0",
      };
    },
    now,
  );
  expect(result.lastExit).toBeNull();
  expect(result.next).toBeNull();
  expect(result.missed).toBe("systemd-managed");
});

test.each(["", "Wed 2026-11-18 23:00:00 UTC"])(
  "running services do not treat an absent or previous exit as current: %s",
  async (finishedAt) => {
    const result = await observeSystemd(
      { ...timer, unit: "backup.service" },
      async () => ({
        code: 0,
        err: "",
        out: `LoadState=loaded\nActiveState=active\nExecMainStartTimestamp=Thu 2026-11-19 00:00:00 UTC\nExecMainExitTimestamp=${finishedAt}\nExecMainStatus=0\nResult=success`,
      }),
      now,
    );
    expect(result.lastExit).toBeNull();
  },
);

test.each([
  { started: "1000001", finished: "1000000", completed: false },
  { started: "1000000", finished: "1000001", completed: true },
  { started: "not-a-clock", finished: "1000001", completed: false },
  { started: "0", finished: "1000001", completed: false },
])("same-second service exits use valid monotonic ordering: %j", async ({ started, finished, completed }) => {
  const result = await observeSystemd(
    { ...timer, unit: "backup.service" },
    async () => ({
      code: 0,
      err: "",
      out: `LoadState=loaded
ActiveState=active
ExecMainStartTimestamp=Thu 2026-11-19 00:00:00 UTC
ExecMainExitTimestamp=Thu 2026-11-19 00:00:00 UTC
ExecMainStartTimestampMonotonic=${started}
ExecMainExitTimestampMonotonic=${finished}
ExecMainStatus=0
Result=success`,
    }),
    now,
  );
  if (completed) expect(result.lastExit?.code).toBe(0);
  else expect(result.lastExit).toBeNull();
});

test("missing and unreadable units remain explicit boot failures without rewriting adoption", async () => {
  const store = new ScheduleStore(state.dir);
  await store.adopt(timer);
  const before = readFileSync(store.path, "utf8");
  const result = await scheduleBoot(state.dir, async () => ({ code: 0, err: "", out: "LoadState=not-found" }), now);
  expect(result.failed).toBe(true);
  expect(result.lines[0]).toContain("not found");
  expect(readFileSync(store.path, "utf8")).toBe(before);
});

test("boot includes cron next/last/missed state without starting or recovering a job", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(now), state.dir, {
    sessionsDir: join(state.dir, "sessions"),
    leadPane: "tern:5001",
  });
  const store = new ScheduleStore(state.dir);
  await store.add(
    { name: "report", cron: "0 9 * * *", tz: "Asia/Seoul", cwd: state.dir, argv: ["false"], deliver: "log" },
    now,
  );
  const before = readFileSync(store.path, "utf8");
  const result = await bootCheck({
    ...deps,
    reports: new Reports(state.dir),
    worklog: new Worklog(state.dir),
    slack: async () => null,
  });
  expect(result.exitCode).toBe(0);
  expect(result.lines).toContain(
    "SCHEDULE report paused=false next=2026-11-20T00:00:00.000Z last=never delivery=none missed=0",
  );
  expect(readFileSync(store.path, "utf8")).toBe(before);
  expect(existsSync(join(state.dir, "scheduler.lock"))).toBe(false);
  expect(existsSync(join(state.dir, "schedule-runs"))).toBe(false);
});

test("a cold boot creates no schedule state and corrupted state fails closed", async () => {
  const run: Runner = async () => {
    throw Error("must not observe an unregistered unit");
  };
  expect(await scheduleBoot(state.dir, run, now)).toEqual({ lines: [], failed: false });
  const path = join(state.dir, "schedule.json");
  expect(existsSync(path)).toBe(false);
  writeFileSync(path, "broken");
  expect((await scheduleBoot(state.dir, run, now)).failed).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("broken");
});
