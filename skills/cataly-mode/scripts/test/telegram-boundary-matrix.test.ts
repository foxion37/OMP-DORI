import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileTgInboundStore } from "../src/messenger/telegram-inbound-state.ts";
import { pollTelegramInbound, type TgInbound } from "../src/messenger/telegram-inbound.ts";
import { withState } from "./fakes.ts";
import { GROUP, mk, msg, OTHER, OWNER, telegramFake, TOPIC } from "./telegram-inbound-fakes.ts";

const posix = test.skipIf(process.platform === "win32");
const state = withState();
beforeEach(() => mkdirSync(state.dir, { recursive: true }));
afterEach(() => state.done());

posix.each([
  [
    "another author using the owner username",
    { ...msg(OTHER, OWNER, "private", "spoof"), from: { id: OTHER, username: "owner" } },
  ],
  ["the owner in another private chat", msg(OWNER, OTHER, "private", "wrong chat")],
  [
    "a bot claiming the owner ID",
    { ...msg(OWNER, OWNER, "private", "bot"), from: { id: OWNER, username: "owner", is_bot: true } },
  ],
  [
    "a General reply whose root mimics the topic",
    { ...msg(OWNER, GROUP, "supergroup", "wrong topic", TOPIC, false), reply_to_message: { message_id: TOPIC } },
  ],
  ["a channel masquerading as the configured group", msg(OWNER, GROUP, "channel", "wrong source", TOPIC, true)],
  ["a private message without an author", { message_id: 1, chat: { id: OWNER, type: "private" }, text: "anonymous" }],
] as const)("%s cannot enter either the message or edit consumer", async (_name, rejected) => {
  for (const kind of ["message", "edited_message"] as const) {
    const { http, bodies } = telegramFake([
      [
        { update_id: 100, [kind]: rejected },
        { update_id: 101, [kind]: msg(OWNER, OWNER, "private", "allowed") },
      ],
    ]);
    const store = fileTgInboundStore(join(state.dir, `route-${kind}`), 900);
    const seen: TgInbound[] = [];
    const { inbound } = await pollTelegramInbound(
      mk(http),
      store,
      { ownerId: OWNER, groupChatId: GROUP, topicId: TOPIC },
      (message) => {
        seen.push(message);
      },
    );
    expect(seen.map((message) => [message.updateId, message.kind, message.source, message.text])).toEqual([
      [101, kind === "message" ? "message" : "edit", "dm", "allowed"],
    ]);
    expect(inbound).toEqual(seen);
    expect(store.load()?.offset).toBe(102);
    expect(bodies[0]).not.toHaveProperty("offset");
  }
});

posix(
  "message IDs may decrease across chats and repeat for edits without reordering or deduplicating updates",
  async () => {
    const dm = { ...msg(OWNER, OWNER, "private", "first"), message_id: 90 };
    const topic = { ...msg(OWNER, GROUP, "supergroup", "topic", TOPIC, true), message_id: 2 };
    const { http, bodies } = telegramFake([
      [
        { update_id: 200, message: dm },
        { update_id: 201, message: topic },
        { update_id: 202, edited_message: { ...dm, text: "corrected DM" } },
        { update_id: 203, edited_message: { ...topic, text: "corrected topic" } },
        { update_id: 204, message: { ...dm, message_id: 91, text: "next" } },
      ],
      [],
    ]);
    const path = join(state.dir, "identity-offset");
    const store = fileTgInboundStore(path, 900);
    store.save({ offset: 200, observedAt: Date.now(), seen: [] });
    const seen: TgInbound[] = [];
    const offsetsAtEmit: number[] = [];
    const opts = { ownerId: OWNER, groupChatId: GROUP, topicId: TOPIC };
    const { inbound } = await pollTelegramInbound(mk(http), store, opts, (message) => {
      offsetsAtEmit.push(store.load()!.offset);
      seen.push(message);
    });
    expect(
      seen.map((message) => [message.updateId, message.kind, message.chat, message.messageId, message.text]),
    ).toEqual([
      [200, "message", OWNER, 90, "first"],
      [201, "message", GROUP, 2, "topic"],
      [202, "edit", OWNER, 90, "corrected DM"],
      [203, "edit", GROUP, 2, "corrected topic"],
      [204, "message", OWNER, 91, "next"],
    ]);
    expect(inbound).toEqual(seen);
    expect(offsetsAtEmit).toEqual([200, 201, 202, 203, 204]);
    expect(store.load()?.offset).toBe(205);
    const resumed = await pollTelegramInbound(mk(http), fileTgInboundStore(path, 900), opts, (message) => {
      seen.push(message);
    });
    expect(resumed.inbound).toEqual([]);
    expect(bodies.map((body) => body["offset"])).toEqual([200, 205]);
    expect(seen).toHaveLength(5);
  },
);
