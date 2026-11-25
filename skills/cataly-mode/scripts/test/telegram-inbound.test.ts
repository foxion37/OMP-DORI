import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileTgInboundStore } from "../src/messenger/telegram-inbound-state.ts";
import { pollTelegramInbound } from "../src/messenger/telegram-inbound.ts";
import { inboundLagLog } from "../src/messenger/telegram-lag.ts";
import { withState } from "./fakes.ts";
import { GROUP, mk, msg, OTHER, OWNER, telegramFake, TOPIC } from "./telegram-inbound-fakes.ts";

const posix = test.skipIf(process.platform === "win32");

const state = withState();

// The store's dir is shared across tests; recreate it fresh for each so the
// previous test's offset never bleeds in, and remove it so nothing leaks.
beforeEach(() => mkdirSync(state.dir, { recursive: true }));

afterEach(() => state.done());

posix("owner DMs pass, non-owner and bot messages drop, offset still advances", async () => {
  const { http, bodies } = telegramFake([
    [
      { update_id: 10, message: msg(OWNER, OWNER, "private", "hi") },
      { update_id: 11, message: msg(OTHER, OTHER, "private", "intruder") },
      {
        update_id: 12,
        message: {
          message_id: 1,
          from: { id: 777, is_bot: true },
          chat: { id: OWNER, type: "private" },
          text: "bot ping",
        },
      },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-1"), 900);
  const { inbound: out } = await pollTelegramInbound(mk(http), store, {
    ownerId: OWNER,
    groupChatId: GROUP,
    topicId: TOPIC,
  });
  expect(out.length).toBe(1);
  expect(out[0]!.source).toBe("dm");
  expect(out[0]!.text).toBe("hi");
  expect(out[0]!.updateId).toBe(10);
  // Offset persisted past ALL updates, including the dropped ones — no replay, no loss.
  expect(store.load()?.offset).toBe(13);
  expect(bodies[0]!).not.toHaveProperty("offset");
});

posix("configured topic passes, other topics and other groups drop", async () => {
  const { http } = telegramFake([
    [
      { update_id: 20, message: msg(OWNER, GROUP, "supergroup", "in topic", TOPIC, true) },
      { update_id: 21, message: msg(OWNER, GROUP, "supergroup", "wrong topic", 555, true) },
      { update_id: 22, message: msg(OWNER, -999, "supergroup", "wrong group", TOPIC, true) },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-2"), 900);
  const { inbound: out } = await pollTelegramInbound(mk(http), store, {
    ownerId: OWNER,
    groupChatId: GROUP,
    topicId: TOPIC,
  });
  expect(out.length).toBe(1);
  expect(out[0]!.source).toBe("topic");
  expect(out[0]!.thread).toBe(TOPIC);
  expect(out[0]!.text).toBe("in topic");
  expect(store.load()?.offset).toBe(23);
});

posix("a reply in the General topic counts as topic 1, not its reply-root id", async () => {
  const { http } = telegramFake([
    [
      // Direct post in General: no thread markers at all.
      { update_id: 30, message: msg(OWNER, GROUP, "supergroup", "general post") },
      // Reply inside General: message_thread_id is the reply ROOT's id (not a topic id),
      // and is_topic_message is false — telegram-bot-api#447.
      { update_id: 31, message: msg(OWNER, GROUP, "supergroup", "general reply", 1234, false) },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-3"), 900);
  const { inbound: out } = await pollTelegramInbound(mk(http), store, {
    ownerId: OWNER,
    groupChatId: GROUP,
    topicId: 1,
  });
  expect(out.length).toBe(2);
  expect(out[0]!.thread).toBe(1);
  expect(out[1]!.thread).toBe(1);
});

posix(
  "a reply names the message it answers; a topic's own root, named on every topic message, is no reply",
  async () => {
    const replying = (text: string, target: number, thread: number, isTopic: boolean) => ({
      ...msg(OWNER, GROUP, "supergroup", text, thread, isTopic),
      reply_to_message: { message_id: target },
    });
    const { http } = telegramFake([
      [
        { update_id: 60, message: replying("plain post in topic 3", TOPIC, TOPIC, true) },
        { update_id: 61, message: replying("2", 77, TOPIC, true) },
        // In General a reply's message_thread_id is its reply root, which may be the very message it answers.
        { update_id: 62, message: replying("1", 1234, 1234, false) },
        { update_id: 63, edited_message: replying("2, sorry", 77, TOPIC, true) },
      ],
    ]);
    const store = fileTgInboundStore(join(state.dir, "tg-off-reply"), 900);
    const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER, groupChatId: GROUP });
    // The last is the owner's edit of the reply: it still names the message it answers.
    expect(out.map((i) => i.replyTo ?? "-")).toEqual(["-", 77, 1234, 77]);
  },
);

posix("a private chat run with topics carries the topic on DMs", async () => {
  const { http } = telegramFake([
    [
      { update_id: 40, message: msg(OWNER, OWNER, "private", "plain dm") },
      { update_id: 41, message: msg(OWNER, OWNER, "private", "dm in topic 7", 7, true) },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-4"), 900);
  const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(2);
  expect(out[0]!.thread).toBeUndefined();
  expect(out[1]!.source).toBe("dm");
  expect(out[1]!.thread).toBe(7);
});

posix("without a configured group only DMs arrive", async () => {
  const { http } = telegramFake([
    [{ update_id: 50, message: msg(OWNER, GROUP, "supergroup", "group msg", TOPIC, true) }],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-5"), 900);
  const { inbound: out } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(0);
});

posix("restart resumes from the persisted offset", async () => {
  const { http, bodies } = telegramFake([
    [],
    [{ update_id: 60, message: msg(OWNER, OWNER, "private", "after restart") }],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-6"), 900);
  store.save({ offset: 60, observedAt: Date.now(), seen: [] }); // what a previous run persisted
  const { inbound: first } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(first.length).toBe(0);
  expect(bodies[0]!["offset"]).toBe(60);
  const { inbound: second } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(second.length).toBe(1);
  expect(second[0]!.updateId).toBe(60);
  expect(bodies[1]!["offset"]).toBe(60);
  expect(store.load()?.offset).toBe(61);
});

posix("a crash mid-emit replays the unprinted message, not the printed one", async () => {
  const { http, bodies } = telegramFake([
    [{ update_id: 70, message: msg(OWNER, OWNER, "private", "first") }],
    [
      { update_id: 71, message: msg(OWNER, OWNER, "private", "second") },
      { update_id: 72, message: msg(OWNER, OWNER, "private", "third") },
    ],
    [
      { update_id: 71, message: msg(OWNER, OWNER, "private", "second") },
      { update_id: 72, message: msg(OWNER, OWNER, "private", "third") },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-7"), 900);
  // First poll: prints "first", offset advances past it.
  const seen1: string[] = [];
  await pollTelegramInbound(mk(http), store, { ownerId: OWNER }, (i) => seen1.push(i.text ?? ""));
  expect(seen1).toEqual(["first"]);
  expect(store.load()?.offset).toBe(71);
  // Second poll: emit throws on "second" — offset must stay before it.
  await expect(
    pollTelegramInbound(mk(http), store, { ownerId: OWNER }, () => {
      throw new Error("print died");
    }),
  ).rejects.toThrow("print died");
  expect(store.load()?.offset).toBe(71); // not advanced past 71
  // Third poll restarts from 71 and returns the unprinted messages again.
  const seen3: string[] = [];
  const { inbound: out3 } = await pollTelegramInbound(mk(http), store, { ownerId: OWNER }, (i) =>
    seen3.push(i.text ?? ""),
  );
  expect(seen3).toEqual(["second", "third"]);
  expect(out3.map((i) => i.updateId)).toEqual([71, 72]);
  expect(bodies[2]!["offset"]).toBe(71);
  expect(store.load()?.offset).toBe(73);
});

posix("dated owner intake records original-message lag without changing cursor or owner filtering", async () => {
  const date = 1_700_000_000;
  const { http } = telegramFake([
    [
      { update_id: 100, message: { ...msg(OWNER, OWNER, "private", "first"), date } },
      {
        update_id: 101,
        edited_message: { ...msg(OWNER, OWNER, "private", "edited"), date, edit_date: date + 1000 },
      },
      { update_id: 102, message: msg(OWNER, OWNER, "private", "without date") },
      { update_id: 103, message: { ...msg(OTHER, OTHER, "private", "not the owner"), date } },
    ],
  ]);
  const path = join(state.dir, "telegram-lag.jsonl");
  const record = inboundLagLog(path);
  const store = fileTgInboundStore(join(state.dir, "tg-off-lag"), 900);
  await pollTelegramInbound(mk(http), store, { ownerId: OWNER }, (inbound) => record(inbound, 1_700_000_002_250));
  const records = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { updateId: number; kind: string; lagMs?: number });
  expect(records.map(({ updateId, kind, lagMs }) => [updateId, kind, lagMs])).toEqual([
    [100, "message", 2250],
    [101, "edit", 2250],
    [102, "message", undefined],
  ]);
  expect(records[2]).not.toHaveProperty("lagMs");
  expect(store.load()?.offset).toBe(104);
});
