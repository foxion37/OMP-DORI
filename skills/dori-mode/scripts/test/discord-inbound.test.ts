import { expect, test } from "bun:test";
import { discordInbound, formatDiscordInbound, type DiscordInbound } from "../src/messenger/discord-inbound.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";

const options = { ownerId: "10", channelIds: ["20"] };

test("cold start baselines latest history, then admits only owner text in the exact configured channel", async () => {
  const world = discordRestWorld([ownerMessage("99"), ownerMessage("100")]);
  const cursor = memoryDiscordCursor();
  const intake = await discordInbound(world.discord, () => cursor.store, options);
  expect(intake.botId).toBe("99");
  expect(cursor.saved).toEqual(["100"]);
  const received: DiscordInbound[] = [];
  await intake.poll((message) => received.push(message));
  expect(received).toEqual([]);
  world.state.messages.push(
    ownerMessage("101", { content: 'hello\n"quoted" $(data)' }),
    ownerMessage("102", { author: { id: "11" }, content: "private non-owner text" }),
    ownerMessage("103", { author: { id: "10", bot: true }, content: "private bot text" }),
    ownerMessage("104", { author: { id: "99", bot: true }, content: "private self text" }),
    ownerMessage("105", { type: 7, content: "private system text" }),
    ownerMessage("107", { type: 19, message_reference: { message_id: "101" }, content: "reply" }),
    ownerMessage("108", { webhook_id: "30", content: "private webhook text" }),
    ownerMessage("109", { author: { id: "10", system: true }, content: "private system author" }),
    ownerMessage("111", { author: { id: "11" } }),
    ownerMessage("999", { channel_id: "21", content: "private foreign-channel text" }),
  );
  await intake.poll((message) => received.push(message));
  expect(received).toEqual([
    { channel: "20", message: "101", reference: null, text: 'hello\n"quoted" $(data)', replyTo: null, attachments: [] },
    { channel: "20", message: "107", reference: "101", text: "reply", replyTo: null, attachments: [] },
  ]);
  expect(received.map(formatDiscordInbound)).toEqual([
    'INBOUND discord 20 101 from=owner ref=- "hello\\n\\"quoted\\" $(data)"',
    'INBOUND discord 20 107 from=owner ref=101 "reply"',
  ]);
  expect(received.map(formatDiscordInbound).join("\n")).not.toContain("private");
  expect(cursor.store.load()).toBe("111");
  world.state.messages.push(ownerMessage("112"));
  await intake.poll((message) => received.push(message));
  expect(received.map((message) => message.message)).toEqual(["101", "107", "112"]);
  expect(cursor.store.load()).toBe("112");
  expect(world.requests.every((request) => request.method === "GET")).toBe(true);
  expect(world.requests.every((request) => request.headers?.["Authorization"] === "Bot unit-private-token")).toBe(true);
});

test("an empty cold channel persists zero and delivers the first later message", async () => {
  const world = discordRestWorld();
  const cursor = memoryDiscordCursor();
  const intake = await discordInbound(world.discord, () => cursor.store, options);
  expect(cursor.saved).toEqual(["0"]);
  world.state.messages.push(ownerMessage("1"));
  const received: DiscordInbound[] = [];
  await intake.poll((message) => received.push(message));
  expect(received.map((message) => message.message)).toEqual(["1"]);
  expect(cursor.store.load()).toBe("1");
});

test("restart drains every page after the cursor in numeric order without duplicates or precision loss", async () => {
  const base = 900_719_925_474_099_300n;
  const ids = Array.from({ length: 251 }, (_, index) => String(base + BigInt(index + 1)));
  const world = discordRestWorld([ownerMessage(String(base)), ...ids.map((id) => ownerMessage(id))]);
  world.state.overlap = true;
  const cursor = memoryDiscordCursor(String(base));
  const intake = await discordInbound(world.discord, () => cursor.store, options);
  expect(cursor.saved).toEqual([]);
  const received: DiscordInbound[] = [];
  await intake.poll((message) => received.push(message));
  expect(received.map((message) => message.message)).toEqual(ids);
  expect(cursor.saved).toEqual(ids);
  expect(cursor.store.load()).toBe(ids.at(-1));
  await intake.poll((message) => received.push(message));
  expect(received).toHaveLength(251);
  expect(cursor.saved).toHaveLength(251);
  const pages = world.requests
    .map((request) => new URL(request.url))
    .filter((url) => url.searchParams.get("limit") === "100");
  expect(pages.map((url) => url.searchParams.get("before"))).toEqual([
    null,
    String(base + 152n),
    String(base + 53n),
    null,
  ]);
});

test("duplicate messages within a history page emit and checkpoint only once", async () => {
  const world = discordRestWorld([ownerMessage("101"), ownerMessage("101"), ownerMessage("102")]);
  const cursor = memoryDiscordCursor("100");
  const intake = await discordInbound(world.discord, () => cursor.store, options);
  const received: string[] = [];
  await intake.poll((message) => received.push(message.message));
  expect(received).toEqual(["101", "102"]);
  expect(cursor.saved).toEqual(["101", "102"]);
});

test("a failed emitter leaves the failed message uncommitted and resumes without replaying successful delivery", async () => {
  const world = discordRestWorld([
    ownerMessage("101"),
    ownerMessage("102", {
      type: 19,
      content: "",
      message_reference: { message_id: "90" },
      referenced_message: { id: "90", author: { id: "99" }, content: "context" },
      attachments: [{ filename: "notes", size: 1, url: "https://cdn.discordapp.com/notes?ex=1&hm=2" }],
    }),
    ownerMessage("103"),
  ]);
  const cursor = memoryDiscordCursor("100");
  const intake = await discordInbound(world.discord, () => cursor.store, options);
  const received: string[] = [];
  const groups: string[] = [];
  await expect(
    intake.poll((message) => {
      const group = formatDiscordInbound(message);
      if (message.message === "102") {
        expect(cursor.store.load()).toBe("101");
        groups.push(group);
        throw new Error("delivery failed");
      }
      received.push(message.message);
    }),
  ).rejects.toThrow("delivery failed");
  expect(received).toEqual(["101"]);
  expect(cursor.store.load()).toBe("101");
  await intake.poll((message) => {
    if (message.message === "102") {
      expect(cursor.store.load()).toBe("101");
      groups.push(formatDiscordInbound(message));
    }
    received.push(message.message);
  });
  expect(received).toEqual(["101", "102", "103"]);
  expect(cursor.saved).toEqual(["101", "102", "103"]);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toBe(
    [
      'INBOUND discord 20 102 from=owner ref=90 ""',
      'INBOUND_REPLY discord 20 102 {"id":"90","author":"99","text":"context"}',
      'INBOUND_ATTACHMENT discord 20 102 {"filename":"notes","size":1,"url":"https://cdn.discordapp.com/notes?ex=1&hm=2"}',
    ].join("\n"),
  );
  expect(groups[1]).toBe(groups[0]);
});

test("a later-page failure emits nothing and retains the cursor for a complete retry", async () => {
  const world = discordRestWorld(Array.from({ length: 150 }, (_, index) => ownerMessage(String(index + 1))));
  const cursor = memoryDiscordCursor("0");
  const intake = await discordInbound(world.discord, () => cursor.store, options);
  world.state.failBefore = true;
  const received: string[] = [];
  await expect(intake.poll((message) => received.push(message.message))).rejects.toThrow(MessengerError);
  expect(received).toEqual([]);
  expect(cursor.store.load()).toBe("0");
  expect(cursor.saved).toEqual([]);
  world.state.failBefore = false;
  await intake.poll((message) => received.push(message.message));
  expect(received).toEqual(Array.from({ length: 150 }, (_, index) => String(index + 1)));
  expect(cursor.store.load()).toBe("150");
});
