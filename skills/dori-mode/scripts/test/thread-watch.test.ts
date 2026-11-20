import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import { withDeliveryLock } from "../src/delivery-lock.ts";
import { watchTick } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run } from "../src/run.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const EXPIRED = T0 + 60 * 60_000;
const THREAD = "discord:40";
const groupKey = `@thread-${createHash("sha256").update(THREAD).digest("hex")}`;
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const claimed = (key: string, done: string): Lane => ({
  key,
  title: key,
  brief: "/b.md",
  thread: THREAD,
  done,
  openedAt: new Date(T0).toISOString(),
  status: "done-claimed",
  claim: { at: new Date(T0).toISOString(), evidence: done, emitted: true },
});

const git = async (...args: readonly string[]): Promise<void> => {
  const result = await run([
    "git",
    "-C",
    state.dir,
    "-c",
    "user.name=Dori Fixture",
    "-c",
    "user.email=dori-fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ]);
  if (result.code !== 0) throw new Error(`Git fixture ${args.join(" ")}: ${result.err}`);
};

test.each(["tracked edit", "unpushed commit"])("watch blocks a %s added during the group wait", async (change) => {
  await git("init", "--quiet", "--template=");
  const tracked = join(state.dir, "tracked.txt");
  const hook = join(state.dir, "thread-hook");
  await Bun.write(tracked, "baseline\n");
  await git("add", "--force", "tracked.txt");
  await git("commit", "--quiet", "--no-gpg-sign", "-m", "baseline");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");

  const base = depsFor(newWorld(), fakeClock(EXPIRED), state.dir, {
    defaultCwd: state.dir,
    threadDonePolicy: "last-lane",
    hooks: { threadDone: ["touch", hook] },
  });
  const lane = claimed("git-lane", "file tracked.txt");
  await base.registry.write(lane);
  const release = Promise.withResolvers<void>();
  const held = withDeliveryLock(base, groupKey, () => release.promise);
  try {
    const deps = {
      ...base,
      run,
      clock: {
        ...base.clock,
        sleep: async () => {
          await Bun.write(tracked, "new work\n");
          if (change === "unpushed commit") await git("commit", "--quiet", "--no-gpg-sign", "-am", "local only");
          release.resolve();
          await held;
        },
      },
    };
    expect(await watchTick(deps)).toEqual([`LANE_NOT_DONE git-lane unpushed work in ${state.dir}`]);
    const stored = await deps.registry.read(lane.key);
    expect(stored).toMatchObject({ status: "not-done", objection: { reasons: [`unpushed work in ${state.dir}`] } });
    expect(stored?.nativeCloseIntent).toBeUndefined();
    expect(stored?.receipt).toBeUndefined();
    expect(await Bun.file(hook).exists()).toBe(false);
  } finally {
    release.resolve();
    await held;
  }
});

test("watcher leaves an expired legacy verified claim without a waiting marker untouched", async () => {
  const signal = join(state.dir, "done");
  const hook = join(state.dir, "thread-hook");
  await Bun.write(signal, "done");
  const deps = {
    ...depsFor(newWorld(), fakeClock(EXPIRED), state.dir, {
      defaultCwd: state.dir,
      hooks: { threadDone: ["touch", hook] },
    }),
    run,
  };
  const lane = { ...claimed("legacy-lane", "file done"), status: "verified-done" } as const;
  await deps.registry.write(lane);

  expect(await watchTick(deps)).toEqual([]);
  expect(await deps.registry.read(lane.key)).toEqual(lane);
  expect(await Bun.file(hook).exists()).toBe(false);
});

test("a miskeyed row holds its strict group election without stopping a later ungrouped close", async () => {
  await Bun.write(join(state.dir, "done"), "done");
  const hook = join(state.dir, "thread-hook");
  const deps = {
    ...depsFor(newWorld(), fakeClock(EXPIRED), state.dir, {
      defaultCwd: state.dir,
      threadDonePolicy: "last-lane",
      hooks: { threadDone: ["touch", hook] },
    }),
    run,
  };
  const one = claimed("first-lane", "file done");
  const two = claimed("second-lane", "file done");
  await deps.registry.write(one);
  await deps.registry.write(two);
  const badPath = deps.registry.path("broken-row");
  await Bun.write(badPath, JSON.stringify({ ...one, key: "third-lane", status: "working", claim: undefined }));
  const [first, later] = (await deps.registry.list()).filter((lane) => lane.claim);
  if (!first || !later) throw new Error("expected two claims in watcher order");
  // Preserve the directory entries while making the second observed lane ungrouped.
  await Bun.write(deps.registry.path(later.key), JSON.stringify({ ...later, thread: "none" }));

  const lines = await watchTick(deps);
  expect(lines[0]).toStartWith(`LANE_HELD ${first.key}: thread membership unreadable:`);
  expect(lines[0]).toContain(badPath);
  expect(lines[1]).toStartWith(`LANE_CLOSED ${later.key}`);
  expect(await deps.registry.read(first.key)).toEqual(first);
  expect(await deps.registry.read(later.key)).toMatchObject({ status: "closed", receipt: { outcome: "done" } });
  expect(await Bun.file(hook).exists()).toBe(false);
});

test("boot recommends STOP for a legacy finished lane but not a verified claim waiting on its group", async () => {
  const pane = "w1:first-lane";
  const pending = { ...claimed("first-lane", "merged acme/app#1"), pane };
  const world = newWorld();
  world.panes = [{ pane_id: pane, workspace_id: "w1", agent: "pi", agent_status: "idle" }];
  let now = EXPIRED;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const deps = depsFor(world, clock, state.dir, {
    threadDonePolicy: "last-lane",
    sessionsDir: join(state.dir, "sessions"),
  });
  await deps.registry.write(pending);
  const held = await withDeliveryLock(deps, groupKey, () => watchTick(deps));
  expect(held.ok && held.value[0]).toStartWith("LANE_HELD first-lane thread close in flight");
  expect(await deps.registry.read(pending.key)).toMatchObject({ status: "verified-done", claim: pending.claim });
  await deps.registry.write({ ...claimed("legacy-lane", pending.done), status: "verified-done", thread: "none" });

  const monitorDir = join(state.dir, "terminal");
  mkdirSync(monitorDir);
  const monitors = [
    { command: "dori checkpoints first-lane", monitorId: "mon_PENDING", sessionId: "owner", persistent: true },
    { command: "dori checkpoints legacy-lane", monitorId: "mon_LEGACY", sessionId: "owner", persistent: true },
  ];
  writeFileSync(join(monitorDir, "owner.json"), JSON.stringify({ version: 1, sessionId: "owner", monitors }));
  const boot = await bootCheck({
    ...deps,
    monitorDirs: [monitorDir],
    reports: new Reports(state.dir),
    worklog: new Worklog(state.dir),
    slack: async () => null,
  });
  expect(boot.lines.filter((line) => line.startsWith("STOP "))).toEqual([
    'STOP in the owner session only: kill_bash({"bash_id":"mon_LEGACY"})',
  ]);
});
