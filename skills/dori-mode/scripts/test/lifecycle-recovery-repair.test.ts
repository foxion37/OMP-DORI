import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { holdLines } from "../src/holds.ts";
import { paneStatePath, readPaneState, writePaneState } from "../src/lane-state.ts";
import { discordLaneTarget, openDiscordLaneInbox } from "../src/messenger/discord-lane-inbox.ts";
import { parkLane } from "../src/park.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { type Lane, Registry, statusOf } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import type { Clock } from "../src/run.ts";
import { agentIn, fakeClock, laneState, sent } from "./fakes.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

const reason = "owner requested park";
const condition = "after review approval";
const owner = {
  channel: "123",
  message: "456",
  text: "owner follow-up",
  reference: null,
  replyTo: null,
  attachments: [],
};
let f: LifecycleFixture;
let lane: Lane;
let clock: Clock & { at: number };
beforeEach(async () => {
  f = await lifecycleFixture();
  clock = Object.assign(fakeClock(f.deps.clock.now()), {
    sleep: async (ms: number) => {
      clock.at += ms;
    },
  });
  f.deps = { ...f.deps, clock };
  const thread = `discord:${owner.channel}`;
  await f.deps.registry.write({ ...f.lane, session: f.session, sessionFile: f.file, thread });
  lane = (await f.deps.registry.read(f.lane.key))!;
});
afterEach(() => f.state.done());
const currentLane = async () => (await f.deps.registry.read(lane.key))!;
const closes = () => f.world.calls.filter((a) => a[0] === "herdr" && a[2] === "close");
const p7 = "w1:p7";
const p8 = "w1:p8";
async function interruptPark(): Promise<Lane> {
  let cut = false;
  // Lose the first registry commit after the actual pane removal, not the earlier park preparation.
  const registry = new (class extends Registry {
    override transition(seen: Lane, next: (current: Lane) => Lane): Promise<Lane | null> {
      if (cut) {
        cut = false;
        return Promise.resolve(null);
      }
      return super.transition(seen, next);
    }
  })(f.state.dir);
  const interrupted = await parkLane(
    {
      ...f.deps,
      registry,
      run: async (argv, options) => {
        const result = await f.deps.run(argv, options);
        if (result.code === 0 && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "close" && argv[3] === p7) {
          const state = readPaneState(f.state.dir, p7)!;
          writePaneState(f.state.dir, { ...state, pid: 0, discordLaneInbox: true });
          cut = true;
        }
        return result;
      },
    },
    lane,
    reason,
    "parked",
    condition,
  );
  expect(interrupted.code).toBe(3);
  expect(cut).toBe(false);
  expect(closes()).toHaveLength(1);
  expect(f.world.panes).toEqual([]);
  const saved = await currentLane();
  expect(statusOf(saved)).toBe("paused");
  expect(saved.receipt).toBeUndefined();
  expect(saved).toMatchObject({ session: f.session, sessionFile: f.file });
  return saved;
}
async function queueOwner(inbox: ReturnType<typeof openDiscordLaneInbox>) {
  const target = await discordLaneTarget(f.state.dir, owner.channel);
  expect(target).toEqual({ key: lane.key, session: f.session });
  inbox.add(target!.session, owner);
  const pending = inbox.next(f.session, owner.channel);
  expect(pending).toEqual({ id: owner.message, text: 'INBOUND discord 123 456 from=owner ref=- "owner follow-up"' });
  return pending;
}
// The native Discord inbox requires POSIX ownership and permission checks.
const posix = test.skipIf(process.platform === "win32");

posix("explicit reopen recovers interrupted park without losing queued owner work", async () => {
  const saved = await interruptPark();
  const inbox = openDiscordLaneInbox(f.state.dir);
  try {
    const pending = await queueOwner(inbox);
    const parked = await parkLane(f.deps, saved, "later note");
    expect(parked.code).toBe(3);
    expect(parked.lines.join("\n")).toContain("Discord messages are still pending");
    expect((await parkLane(f.deps, saved, "later note", "abandoned")).code).toBe(3);
    expect(await currentLane()).toEqual(saved);
    clock.at += 60_000;
    const reopened = await reopenLane(f.deps, saved);
    expect(reopened.code).toBe(0);
    expect(reopened.lines.join("\n")).toContain(`REOPENED ${lane.key} pane=${p8} session=${f.session}`);
    const { thread } = lane;
    expect(await currentLane()).toMatchObject({ pane: p8, session: f.session, sessionFile: f.file, thread });
    expect(statusOf(await currentLane())).toBe("working");
    expect(f.creates()).toBe(1);
    expect(f.world.calls.find((a) => a[1] === "pane" && a[2] === "run")?.[4]).toContain(`--resume=${f.file}`);
    expect(readPaneState(f.state.dir, p8)?.goal.status).toBe("active");
    expect(inbox.next(f.session, owner.channel)).toEqual(pending);
    expect(sent(f.world)).toEqual(["/goal pause", "/goal resume"]);
  } finally {
    inbox.close();
  }
});
posix("holds recommends reopen and preserves the interrupted park intent after ack", async () => {
  const saved = await interruptPark();
  const inbox = openDiscordLaneInbox(f.state.dir);
  try {
    await queueOwner(inbox);
    const blocked = await parkLane(f.deps, saved, "later note");
    expect(blocked.code).toBe(3);
    expect(blocked.lines.join("\n")).toContain("Discord messages are still pending");
    inbox.acknowledge(f.session, owner.channel, owner.message);
    expect(inbox.next(f.session, owner.channel)).toBeNull();
    const interruptedHold = holdLines([await currentLane()]).join("\n");
    expect(interruptedHold).toContain(`dori reopen ${lane.key}`);
    expect(interruptedHold).not.toContain(`dori resume ${lane.key}`);
    const settled = await parkLane(f.deps, saved, "later note");
    expect(settled.code).toBe(0);
    expect(settled.lines.join("\n")).toContain(`PARKED ${lane.key}`);
    expect(settled.lines.join("\n")).not.toContain("later note");
    expect(statusOf(await currentLane())).toBe("closed");
    const hold = holdLines([await currentLane()]).join("\n");
    expect(hold).toContain(`reason=${JSON.stringify(reason)}`);
    expect(hold).toContain(`resumeWhen=${JSON.stringify(condition)}`);
    expect(closes()).toHaveLength(1);
    expect(sent(f.world)).toEqual(["/goal pause"]);
  } finally {
    inbox.close();
  }
});
test.each(["unknown native peer", "known shell", "different session"] as const)(
  "reopen distinguishes %s from a proven duplicate",
  async (kind) => {
    const parked = await parkLane(f.deps, lane, reason);
    expect(parked.code).toBe(0);
    const peer = "w1:p9";
    if (kind === "known shell") f.world.panes.push({ pane_id: peer, workspace_id: "w1", foreground: "bash" });
    else {
      f.world.panes.push({ pane_id: peer, workspace_id: "w1", agent: "omp", agent_status: "idle" });
      agentIn(f.world, peer, 4260);
      if (kind === "different session")
        laneState(f.state.dir, peer, {
          cwd: f.deps.config.defaultCwd,
          pid: 4260,
          sessionId: "01a11440-ee81-7f90-b2ed-dcc7d51a0ad0",
        });
    }
    const result = await reopenLane(f.deps, parked.lane);
    const blocked = kind === "unknown native peer";
    expect(result.code).toBe(blocked ? 3 : 0);
    expect(f.creates()).toBe(blocked ? 0 : 1);
    expect(sent(f.world)).toEqual(blocked ? ["/goal pause"] : ["/goal pause", "/goal resume"]);
    expect(statusOf(await currentLane())).toBe(blocked ? "closed" : "working");
  },
);
async function reopenNextGeneration() {
  const parked = await parkLane(f.deps, await currentLane(), reason);
  expect(parked.code).toBe(0);
  clock.at += 60_000;
  const reopened = await reopenLane(f.deps, parked.lane);
  expect(reopened.code).toBe(0);
  expect(reopened.lane.openedAt).not.toBe(parked.lane.openedAt);
  return parked.lane;
}

test.each(["parked", "abandoned"] as const)("stale %s request leaves the new pane untouched", async (outcome) => {
  const stale = await currentLane();
  await reopenNextGeneration();
  const current = await currentLane();
  expect((await parkLane(f.deps, stale, "old request", outcome)).code).toBe(3);
  expect(await currentLane()).toEqual(current);
  expect(f.world.panes.map((p) => p.pane_id)).toEqual([p8]);
  expect(closes()).toHaveLength(1);
  expect(sent(f.world)).toEqual(["/goal pause", "/goal resume"]);
});

test("stale resume cannot wake a newly paused generation", async () => {
  expect((await pauseLane(f.deps, lane, "first hold")).code).toBe(0);
  const stale = await currentLane();
  await reopenNextGeneration();
  expect((await pauseLane(f.deps, await currentLane(), "second hold")).code).toBe(0);
  const current = await currentLane();
  expect((await resumeLane(f.deps, stale, "old request")).code).toBe(3);
  expect(await currentLane()).toEqual(current);
  expect(readPaneState(f.state.dir, p8)?.goal.status).toBe("paused");
  expect(sent(f.world)).toEqual(["/goal pause", "/goal resume", "/goal pause"]);
});

test("stale reopen cannot restart the session after a close–reopen–close cycle", async () => {
  const stale = await reopenNextGeneration();
  expect((await parkLane(f.deps, await currentLane(), "second park")).code).toBe(0);
  const current = await currentLane();
  expect((await reopenLane(f.deps, stale)).code).toBe(3);
  expect(await currentLane()).toEqual(current);
  expect(f.creates()).toBe(1);
  expect(f.world.panes).toEqual([]);
  expect(sent(f.world)).toEqual(["/goal pause", "/goal resume", "/goal pause"]);
});
const malformedGoal = (pane: string, goal: null | undefined) =>
  writeFileSync(paneStatePath(f.state.dir, pane), JSON.stringify({ ...readPaneState(f.state.dir, pane)!, goal }));

test.each(["before send", "after send"] as const)("pause holds on malformed goal %s", async (when) => {
  if (when === "before send") malformedGoal(p7, undefined);
  else f.world.onSendText = (pane) => malformedGoal(pane, null);
  const result = await pauseLane(f.deps, lane, "wait");
  expect(result.code).toBe(3);
  expect(result.lines.join("\n")).toContain("PAUSE_UNVERIFIED");
  expect(await currentLane()).toEqual(lane);
  expect(sent(f.world)).toEqual(when === "before send" ? [] : ["/goal pause"]);
});

test("reopen holds on malformed startup goal without sending resume or note", async () => {
  const parked = await parkLane(f.deps, lane, reason);
  expect(parked.code).toBe(0);
  const result = await reopenLane(
    {
      ...f.deps,
      run: async (argv, options) => {
        const result = await f.deps.run(argv, options);
        if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") malformedGoal(p8, null);
        return result;
      },
    },
    parked.lane,
    "owner note",
  );
  expect(result.code).toBe(3);
  expect(result.lines.join("\n")).toContain("REOPEN_UNVERIFIED");
  expect(await currentLane()).toMatchObject({ pane: p8, session: f.session, status: "paused" });
  expect(sent(f.world)).toEqual(["/goal pause"]);
});
