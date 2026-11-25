import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { writePaneState } from "../../skills/cataly-mode/scripts/src/lane-state.ts";
import {
  type DiscordLaneInbox,
  openDiscordLaneInbox,
} from "../../skills/cataly-mode/scripts/src/messenger/discord-lane-inbox.ts";
import { Registry } from "../../skills/cataly-mode/scripts/src/registry.ts";
import { withState } from "../../skills/cataly-mode/scripts/test/fakes.ts";
import { DiscordLane } from "../discord-lane.ts";
import { type Entry, fakePi, type FakePi, until } from "./fake-pi.ts";

// The lane inbox requires an owner-only directory and a uid check, neither of which exists on Windows.
const posix = test.skipIf(process.platform === "win32");

const pane = "6300";
const session = "lane-monitor-kind";
const channel = "900000000000000111";
const message = "900000000000000112";
// The line the lane delivers for a plain queued message, as `cataly-monitor` carries it.
const text = `[discord] INBOUND discord ${channel} ${message} from=owner ref=- "same body"`;

/** One interactive lane with a queued plain message; the lane reads the branch it is given. */
const withLane = async (entries: Entry[], run: (pi: FakePi, inbox: DiscordLaneInbox) => Promise<void>) => {
  const state = withState();
  const previous = process.env.TERN_PANE;
  process.env.TERN_PANE = pane;
  const inbox = openDiscordLaneInbox(state.dir);
  const lane = new DiscordLane();
  try {
    const pi = fakePi({
      mode: "tui",
      session: { id: session, file: join(state.dir, "transcript.jsonl"), entries },
    });
    const cwd = realpathSync(pi.ctx().cwd);
    writePaneState(state.dir, {
      paneId: pane,
      role: "lane",
      sessionId: session,
      discordLaneInbox: true,
      cwd,
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      goal: { status: "none" },
      approvalPending: false,
    });
    await new Registry(state.dir).create({
      key: "discord-lane",
      title: "Discord lane",
      thread: `discord:${channel}`,
      sessionRef: { id: pane, runtime: "tern" },
      session,
      lifecycleEpoch: "launch",
      brief: "",
      done: "",
      openedAt: "2026-01-01T00:00:00.000Z",
    });
    inbox.add(session, { channel, message, reference: null, text: "same body", replyTo: null, attachments: [] });
    lane.start(pi.api, state.dir, pi.ctx(), undefined, false, {
      idle: () => true,
      approvalFree: () => true,
      goalAllows: () => true,
      consumePause: () => {},
    });
    await run(pi, inbox);
  } finally {
    lane.stop();
    inbox.close();
    if (previous === undefined) delete process.env.TERN_PANE;
    else process.env.TERN_PANE = previous;
    state.done();
  }
};

posix(
  "a delivery the previous main recorded as dori-monitor is not sent again",
  async () => {
    await withLane([{ type: "custom_message", customType: "dori-monitor", content: text }], async (pi, inbox) => {
      // The lane acknowledges a message it already delivered instead of sending it again.
      expect(inbox.next(session, channel)?.id).toBe(message);
      await until(() => !inbox.outstanding(session, channel), 15_000);
      expect(pi.sent).toEqual([]);
      expect(pi.userMessages).toEqual([]);
    });
  },
  20_000,
);

posix(
  "a new lane delivery is written as cataly-monitor only",
  async () => {
    await withLane([], async (pi) => {
      await until(() => pi.sent.length > 0, 15_000);
      expect(pi.sent).toEqual([
        { customType: "cataly-monitor", content: text, options: { triggerTurn: true, deliverAs: "aside" } },
      ]);
      expect(pi.sent.every((sent) => sent.customType !== "dori-monitor")).toBe(true);
    });
  },
  20_000,
);
