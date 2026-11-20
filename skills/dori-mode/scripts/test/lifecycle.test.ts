import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { withDeliveryLock } from "../src/delivery-lock.ts";
import { closeLane, watchTick } from "../src/done-flow.ts";
import { holdLines } from "../src/holds.ts";
import { readPaneState } from "../src/lane-state.ts";
import { openDiscordLaneInbox } from "../src/messenger/discord-lane-inbox.ts";
import { parkLane } from "../src/park.ts";
import { reopenLane } from "../src/reopen.ts";
import { statusOf } from "../src/registry.ts";
import { fakeClock, laneState, sent } from "./fakes.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

test("park preserves incomplete and unpushed work, session, thread, reason and resume condition", async () => {
  f.world.prState = "OPEN";
  f.world.dirty = " M work.ts";
  f.world.aheadCount = "2";
  const r = await parkLane(f.deps, f.lane, "owner said wait", "parked", "after review");
  expect(r.code).toBe(0);
  expect(statusOf(r.lane)).toBe("closed");
  expect(r.lane).toMatchObject({
    session: f.session,
    sessionFile: f.file,
    thread: "none",
    hold: { reason: "owner said wait", resumeWhen: "after review" },
    receipt: { outcome: "parked" },
  });
  expect(r.lines.join("\n")).toContain("WARNING unpushed work");
  expect(existsSync(f.file)).toBe(true);
  expect(sent(f.world)).toEqual(["/goal pause"]);
  expect(f.world.calls.some((a) => a.includes("remove") || a[0] === "notify" || a[0] === "gh")).toBe(false);
  expect(f.world.calls.some((a) => a[1] === "tab" && a[2] === "close")).toBe(false);
  expect(holdLines([r.lane])[0]).toContain("state=parked");
  expect(holdLines([r.lane], "other")).toEqual([]);
  expect(await watchTick(f.deps)).toEqual([]);
});

// The native Discord inbox requires POSIX ownership and permission checks.
const posix = test.skipIf(process.platform === "win32");

posix.each(["parked", "abandoned"] as const)("%s waits for accepted native Discord work", async (outcome) => {
  const lane = { ...f.lane, thread: "discord:123", session: f.session };
  await f.deps.registry.write(lane);
  const inbox = openDiscordLaneInbox(f.state.dir);
  try {
    inbox.add(f.session, {
      channel: "123",
      message: "456",
      text: "owner work",
      reference: null,
      replyTo: null,
      attachments: [],
    });
    const blocked = await parkLane(f.deps, lane, "operator reason", outcome);
    expect(blocked.code).toBe(3);
    expect(blocked.lines[0]).toContain("Discord messages are still pending");
    expect(await f.deps.registry.read(lane.key)).toMatchObject({ pane: lane.pane });
    expect(statusOf(blocked.lane)).toBe("working");
    expect(sent(f.world)).toEqual([]);
    expect(f.world.panes.some((pane) => pane.pane_id === lane.pane)).toBe(true);
    inbox.acknowledge(f.session, "123", "456");
    const settled = await parkLane(f.deps, lane, "operator reason", outcome);
    expect(settled.code).toBe(0);
    expect(settled.lane.receipt).toMatchObject({ outcome });
  } finally {
    inbox.close();
  }
});

test("failed native pause or approval cannot close or claim the lane parked", async () => {
  delete f.world.onSendText;
  expect((await parkLane(f.deps, f.lane, "wait")).code).toBe(3);
  laneState(f.state.dir, "w1:p7", { cwd: f.deps.config.defaultCwd, sessionFile: f.file, approvalPending: true });
  expect((await parkLane(f.deps, f.lane, "wait")).code).toBe(3);
  expect(f.world.calls.some((a) => a[2] === "close")).toBe(false);
  expect(statusOf((await f.deps.registry.read(f.lane.key)) ?? f.lane)).toBe("working");
});

test("close failure keeps a resumable paused record, never a successful parked receipt", async () => {
  f.failClose();
  expect((await parkLane(f.deps, f.lane, "wait")).code).toBe(3);
  const lane = await f.deps.registry.read(f.lane.key);
  expect(lane).toMatchObject({ status: "paused", session: f.session, sessionFile: f.file });
  expect(lane?.closedAt).toBeUndefined();
  expect(lane?.receipt).toBeUndefined();
});

test("normal close still requires Done; explicit abandonment preserves work without a done receipt", async () => {
  f.world.prState = "OPEN";
  expect((await closeLane(f.deps, f.lane, "close")).closed).toBe(false);
  const r = await parkLane(f.deps, f.lane, "superseded", "abandoned");
  expect(r.code).toBe(0);
  expect(r.lane.receipt).toMatchObject({ outcome: "abandoned" });
  expect(holdLines([r.lane])).toEqual([]);
  expect(f.world.calls.some((a) => a.includes("remove"))).toBe(false);
});

test("reopen resumes exactly the saved OMP session with history and original Done intact", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  const r = await reopenLane(f.deps, parked.lane);
  expect(r.code).toBe(0);
  expect(statusOf(r.lane)).toBe("working");
  expect(r.lane).toMatchObject({ session: f.session, done: f.lane.done, pane: "w1:p8", tab: "w1:t8" });
  expect(r.lane.closedAt).toBeUndefined();
  expect(r.lane.receipt).toBeUndefined();
  expect(r.lane.history?.map((h) => h.status)).toContain("closed");
  expect(f.creates()).toBe(1);
  expect(f.world.calls.find((a) => a[2] === "run")?.[4]).toContain(`--resume=${f.file}`);
  expect(readPaneState(f.state.dir, "w1:p8")?.goal.status).toBe("active");
  expect(sent(f.world)).toEqual(["/goal pause", "/goal resume"]);
  expect(holdLines([r.lane])).toEqual([]);
  expect((await reopenLane(f.deps, parked.lane)).code).toBe(3);
  expect(f.creates()).toBe(1);
});

test("concurrent reopens create only one pane", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  const results = await Promise.all([reopenLane(f.deps, parked.lane), reopenLane(f.deps, parked.lane)]);
  expect(results.map((r) => r.code).sort()).toEqual([0, 3]);
  expect(f.creates()).toBe(1);
});

test("an interrupted park completes using its saved identity after the pane disappears", async () => {
  f.failClose();
  const interrupted = await parkLane(f.deps, f.lane, "wait");
  expect(interrupted.code).toBe(3);
  expect(statusOf(interrupted.lane)).toBe("paused");
  f.world.panes = [];
  const r = await parkLane(f.deps, interrupted.lane, "wait");
  expect(r.code).toBe(0);
  expect(r.lane.receipt).toMatchObject({ outcome: "parked" });
});

test("wrong file identity is refused before reopening any pane", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  writeFileSync(f.file, `${JSON.stringify({ type: "session", id: "foreign", cwd: f.deps.config.defaultCwd })}\n`);
  await expect(reopenLane(f.deps, parked.lane)).rejects.toThrow("identity or cwd differs");
  expect(f.creates()).toBe(0);
});

test("wrong resumed session stays paused and receives no goal command", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  f.foreign();
  const r = await reopenLane(f.deps, parked.lane);
  expect(r.code).toBe(3);
  expect(statusOf(r.lane)).toBe("paused");
  expect(sent(f.world)).toEqual(["/goal pause"]);
  expect(f.creates()).toBe(1);
});

test.each(["parked", "abandoned", "reopen"] as const)(
  "%s cannot change existing membership or touch the pane while a sibling election holds the thread lock",
  async (operation) => {
    const lane = { ...f.lane, thread: "discord:40" };
    await f.deps.registry.write(lane);
    const seen = operation === "reopen" ? (await parkLane(f.deps, lane, "prepare reopen")).lane : lane;
    const before = await f.deps.registry.read(lane.key);
    const panes = f.world.panes.map((pane) => pane.pane_id);
    f.world.calls.length = 0;
    const deps = { ...f.deps, config: { ...f.deps.config, threadDonePolicy: "last-lane" as const } };
    const clock = fakeClock(deps.clock.now());
    const waiting = {
      ...deps,
      clock: {
        ...clock,
        sleep: async (ms: number) => {
          clock.at += ms;
        },
      },
    };
    const key = `@thread-${createHash("sha256").update(lane.thread).digest("hex")}`;
    const held = await withDeliveryLock(waiting, key, () =>
      operation === "reopen" ? reopenLane(waiting, seen) : parkLane(waiting, seen, "operator reason", operation),
    );
    expect(held.ok && held.value.code).toBe(3);
    expect(held.ok && held.value.lines[0]).toStartWith(`HELD ${lane.key} thread close in flight`);
    expect(await deps.registry.read(lane.key)).toEqual(before);
    expect(f.world.panes.map((pane) => pane.pane_id)).toEqual(panes);
    expect(sent(f.world)).toEqual([]);
    expect(f.world.calls.some(([cmd, scope, verb]) => cmd === "herdr" && scope === "pane" && verb === "close")).toBe(
      false,
    );
    expect(f.creates()).toBe(0);

    const retried =
      operation === "reopen" ? await reopenLane(deps, seen) : await parkLane(deps, seen, "operator reason", operation);
    expect(retried.code).toBe(0);
    expect(statusOf(retried.lane)).toBe(operation === "reopen" ? "working" : "closed");
    expect(retried.lane).toMatchObject({ session: f.session, sessionFile: f.file, thread: lane.thread });
  },
);
