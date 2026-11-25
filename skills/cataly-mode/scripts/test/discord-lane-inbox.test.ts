import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DiscordInbound } from "../src/messenger/discord-inbound-api.ts";
import { openDiscordLaneInbox, pendingDiscordLane } from "../src/messenger/discord-lane-inbox.ts";
import type { Lane } from "../src/registry.ts";
import { href, sid, type TestState, withState } from "./fakes.ts";

const posix = test.skipIf(process.platform === "win32");
const channel = "123";
const session = "native-session";
const lane: Lane = {
  key: "discord-work",
  title: "Discord work",
  thread: `discord:${channel}`,
  sessionRef: href(sid(1)),
  session,
  brief: "/brief.md",
  done: "work complete",
  openedAt: "2026-01-01T12:00:00.000Z",
};

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const inbound = (message: string, text: string, target = channel): DiscordInbound => ({
  channel: target,
  message,
  text,
  reference: null,
  replyTo: null,
  attachments: [],
});

posix("a registered lane counts its buffered chat as pending until it is acknowledged", () => {
  const inbox = openDiscordLaneInbox(state.dir);
  try {
    inbox.add(session, inbound("9", "buffered for resume"));
    expect(pendingDiscordLane(state.dir, lane)).toBe(true);
    inbox.acknowledge(session, channel, "9");
    expect(pendingDiscordLane(state.dir, lane)).toBe(false);
  } finally {
    inbox.close();
  }
});

posix("the inbox persists numeric FIFO and deduplication independently for each session and channel", () => {
  const otherSession = "other-session";
  const otherChannel = "456";
  const first = inbound("9", "first");
  const inbox = openDiscordLaneInbox(state.dir);
  try {
    inbox.add(session, inbound("11", "third"));
    inbox.add(session, inbound("10", "second"));
    inbox.add(session, first);
    inbox.add(session, inbound("9", "duplicate"));
    inbox.add(otherSession, inbound("9", "other session"));
    inbox.add(session, inbound("9", "other channel", otherChannel));
  } finally {
    inbox.close();
  }

  const reopened = openDiscordLaneInbox(state.dir);
  try {
    reopened.add(session, inbound("9", "duplicate after reopen"));
    expect(reopened.next(session, channel)).toEqual({
      id: "9",
      text: 'INBOUND discord 123 9 from=owner ref=- "first"',
    });
    reopened.acknowledge(session, channel, "9");
    expect(reopened.next(otherSession, channel)).toEqual({
      id: "9",
      text: 'INBOUND discord 123 9 from=owner ref=- "other session"',
    });
    expect(reopened.next(session, otherChannel)).toEqual({
      id: "9",
      text: 'INBOUND discord 456 9 from=owner ref=- "other channel"',
    });
    expect(reopened.next(otherSession, otherChannel)).toBeNull();
    expect(reopened.next(session, channel)?.id).toBe("10");
    reopened.acknowledge(session, channel, "10");
  } finally {
    reopened.close();
  }

  const replay = openDiscordLaneInbox(state.dir);
  try {
    replay.add(session, first);
    expect(replay.next(session, channel)?.id).toBe("11");
    replay.acknowledge(session, channel, "11");
    expect(replay.next(session, channel)).toBeNull();
  } finally {
    replay.close();
  }
});

const identity = { bot: "345", owner: "678" };
const rotated = { ...identity, owner: "789" };

posix("first-admission opt-in survives restart for the original receiver", () => {
  const inbox = openDiscordLaneInbox(state.dir);
  const optedOut = inbound("8", "ordinary input");
  try {
    inbox.add(session, inbound("9", "opted-in input"), { reply: identity });
    inbox.add(session, optedOut);
  } finally {
    inbox.close();
  }

  const reopened = openDiscordLaneInbox(state.dir);
  try {
    reopened.add(session, optedOut, { reply: identity });
    reopened.add(session, inbound("9", "credential rotation replay"), { reply: rotated });
    const pending = [{ session, channel, hasInput: true }];
    expect(reopened.pendingSessions()).toEqual(pending);
    expect(reopened.pendingSessions(identity)).toEqual(pending);
    expect(reopened.pendingSessions(rotated)).toEqual([]);
    expect(reopened.next(session, channel)?.id).toBe("8");
    expect(reopened.next(session, channel, { optedInOnly: true })).toEqual({
      id: "9",
      text: 'INBOUND discord 123 9 from=owner ref=- "opted-in input"',
      reply: true,
    });
    reopened.acknowledge(session, channel, "9");
    expect(reopened.pendingSessions(identity)).toEqual([]);
  } finally {
    reopened.close();
  }
});

posix("the outbox survives partial drain and never recreates captured parts, even after acknowledgement", () => {
  const request = inbound("9", "opted-in input");
  const first = { id: "9", part: 0, text: "first" };
  const second = { id: "9", part: 1, text: "second" };
  const inbox = openDiscordLaneInbox(state.dir);
  try {
    inbox.add(session, request, { reply: identity });
    inbox.enqueueReply("another-session", channel, { id: "9", parts: ["unbound"] });
    inbox.enqueueReply(session, channel, { id: "9", parts: ["first", "second"] });
    expect(inbox.nextReply(session, channel, identity)).toEqual(first);
    inbox.acknowledgeReply(session, channel, first);
    inbox.add(session, inbound("10", "another input"), { reply: identity });
    expect(inbox.pendingSessions(identity)).toEqual([{ session, channel, hasInput: true }]);
    inbox.acknowledge(session, channel, "10");
    inbox.add(session, inbound("11", "held input"), { reply: identity });
    expect(inbox.claimInput(session, channel, "11")).toBe(true);
    expect(inbox.claimInput(session, channel, "11")).toBe(false);
    inbox.holdInput(session, channel, "11");
    inbox.add(session, inbound("12", "unconfirmed dispatch"), { reply: identity });
    expect(inbox.claimInput(session, channel, "12")).toBe(true);
  } finally {
    inbox.close();
  }

  const reopened = openDiscordLaneInbox(state.dir);
  try {
    reopened.add(session, request, { reply: rotated });
    reopened.add(session, inbound("11", "held input replay"), { reply: identity });
    expect(reopened.next(session, channel)).toBeNull();
    reopened.enqueueReply(session, channel, { id: "9", parts: ["different", "reply", "extra"] });
    reopened.acknowledgeReply("another-session", channel, second);
    expect(reopened.nextReply(session, channel, identity)).toEqual(second);
    expect(reopened.nextReply(session, channel, rotated)).toBeNull();
    expect(reopened.nextReply(session, channel, { ...identity, bot: "999" })).toBeNull();
    expect(reopened.nextReply("another-session", channel)).toBeNull();
    expect(reopened.pendingSessions(identity)).toEqual([{ session, channel, hasInput: false }]);
    expect(reopened.pendingSessions(rotated)).toEqual([]);
    reopened.acknowledgeReply(session, channel, second);
    reopened.enqueueReply(session, channel, { id: "9", parts: ["late replay"] });
    expect(reopened.pendingSessions()).toEqual([]);
    reopened.add(session, inbound("13", "new input"), { reply: identity });
    expect(reopened.next(session, channel)?.id).toBe("13");
  } finally {
    reopened.close();
  }
});
