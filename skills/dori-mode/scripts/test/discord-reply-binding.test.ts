import { expect, test } from "bun:test";
import { Discord } from "../src/messenger/discord.ts";
import { discordInbound, formatDiscordInbound } from "../src/messenger/discord-inbound.ts";
import { toInbound } from "../src/messenger/discord-inbound-api.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";
import { liveWorld, memoryLiveWorld } from "./discord-inbound-live-fakes.ts";
import { fakeClock } from "./fakes.ts";

const original = () => ({
  ...ownerMessage("101", { type: 19, content: "answer this one" }),
  message_reference: { message_id: "90", channel_id: "20" },
  referenced_message: { id: "90", channel_id: "20", author: { id: "99" }, content: "original question" },
});

test("a reply preserves its observed snapshot when the input objects are later edited", () => {
  const raw = original();
  const captured = toInbound(raw);
  raw.message_reference.message_id = "91";
  raw.message_reference.channel_id = "21";
  raw.referenced_message.id = "91";
  raw.referenced_message.channel_id = "21";
  raw.referenced_message.author.id = "10";
  raw.referenced_message.content = "edited question";
  expect(captured.reference).toBe("90");
  expect(captured.replyTo).toEqual({ id: "90", author: "99", text: "original question" });
  expect(formatDiscordInbound(captured)).toContain(
    'INBOUND_REPLY discord 20 101 {"id":"90","author":"99","text":"original question"}',
  );
});

test("missing, unavailable and observed-empty reply snapshots stay distinct", () => {
  const raw = original();
  const absent = {
    ...ownerMessage("101", { type: 19, content: "answer this one" }),
    message_reference: raw.message_reference,
  };
  const unavailable = { ...raw, referenced_message: null };
  expect(toInbound(absent).replyTo).toEqual({ id: "90", author: null, text: null, status: "unresolved" });
  expect(toInbound(unavailable).replyTo).toEqual({ id: "90", author: null, text: null, status: "unavailable" });
  expect(toInbound({ ...raw, referenced_message: { id: "90", channel_id: "20" } }).replyTo).toEqual({
    id: "90",
    author: null,
    text: null,
  });
  expect(toInbound({ ...raw, referenced_message: { ...raw.referenced_message, content: "" } }).replyTo).toEqual({
    id: "90",
    author: "99",
    text: "",
  });
  expect(toInbound(ownerMessage("102")).replyTo).toBeNull();
  const noTarget = toInbound({ ...raw, message_reference: { channel_id: "20" }, referenced_message: null });
  expect([noTarget.reference, noTarget.replyTo]).toEqual([null, null]);
  expect(formatDiscordInbound(toInbound(unavailable))).toContain(
    'INBOUND_REPLY discord 20 101 {"id":"90","author":null,"text":null,"status":"unavailable"}',
  );
});

test("a reply snapshot cannot name a different message, channel or thread", () => {
  for (const change of [
    { message_reference: { message_id: "90", channel_id: "21" } },
    { referenced_message: { id: "91", channel_id: "20", author: { id: "99" }, content: "wrong message" } },
    { referenced_message: { id: "90", channel_id: "21", author: { id: "99" }, content: "other thread" } },
    { message_reference: { message_id: "not-an-id", channel_id: "20" } },
  ]) {
    expect(() => toInbound({ ...original(), ...change })).toThrow("reply");
  }
});

test("a mismatched reply stops before its emit and cursor while preserving earlier delivery", async () => {
  const bad = { ...original(), id: "102", message_reference: { message_id: "90", channel_id: "21" } };
  const world = discordRestWorld([ownerMessage("101"), bad, ownerMessage("103")]);
  const cursor = memoryDiscordCursor("100");
  const intake = await discordInbound(world.discord, () => cursor.store, { ownerId: "10", channelIds: ["20"] });
  const delivered: string[] = [];
  await expect(
    intake.poll((message) => {
      delivered.push(message.message);
    }),
  ).rejects.toThrow("reply");
  expect(delivered).toEqual(["101"]);
  expect(cursor.saved).toEqual(["101"]);
  expect(cursor.store.load()).toBe("101");
});

test("a mismatched live Gateway reply remains uncommitted and closes intake", async () => {
  const createWorld = process.platform === "win32" ? memoryLiveWorld : liveWorld;
  const world = await createWorld([], { ownerId: "10", channelIds: ["20"] }, { "20": "100" });
  try {
    const [socket] = world.sockets;
    if (!socket) throw new Error("gateway did not open");
    await world.connect(socket);
    await world.dispatch(socket, ownerMessage("101"));
    const bad = {
      ...original(),
      id: "102",
      referenced_message: { ...original().referenced_message, channel_id: "21" },
    };
    await world.dispatch(socket, bad);
    await expect(world.live.done).rejects.toMatchObject({ status: 502, code: "DISCORD_INBOUND_PROTOCOL_ERROR" });
    expect(world.received).toEqual(["20:101"]);
    expect(world.cursor("20")).toBe("101");
    expect(socket.closed).toBe(true);
    expect(world.pending.size).toBe(0);
  } finally {
    world.live.close();
  }
});

/** A synthetic Discord endpoint enforcing its atomic reply-existence contract, not a preflight lookup. */
const replyServer = (targetChannel: string | null) => {
  const requests: HttpRequest[] = [];
  const created: { channel: string; reference: unknown }[] = [];
  const http: Http = async (request) => {
    requests.push(request);
    const match = /\/channels\/(\d+)\/messages$/.exec(new URL(request.url).pathname);
    if (request.method !== "POST" || !match) throw new Error("unexpected Discord request");
    const channel = match[1];
    const body = JSON.parse(String(request.body));
    const ref = body.message_reference;
    const exists = targetChannel === channel && ref?.message_id === "90";
    if (ref?.fail_if_not_exists === true && !exists)
      return { status: 400, headers: {}, body: JSON.stringify({ message: "Unknown referenced message" }) };
    created.push({ channel: String(channel), reference: exists ? ref : null });
    return { status: 200, headers: {}, body: JSON.stringify({ id: String(200 + created.length) }) };
  };
  return { discord: new Discord(http, fakeClock(0), "synthetic", "https://discord.test/api"), requests, created };
};

test("deleted and other-thread reply targets never degrade into an unlinked post", async () => {
  for (const targetChannel of [null, "21"]) {
    const server = replyServer(targetChannel);
    await expect(server.discord.send("20", "reply ".repeat(500), { replyTo: "90" })).rejects.toThrow(
      "Unknown referenced message",
    );
    expect(server.requests).toHaveLength(1);
    expect(server.created).toEqual([]);
    const body = JSON.parse(String(server.requests[0]?.body));
    expect(body.message_reference).toEqual({ message_id: "90", channel_id: "20", fail_if_not_exists: true });
  }
});

test("a valid reply stays in its exact physical channel without a lookup or extra reference", async () => {
  const server = replyServer("20");
  const text = "reply ".repeat(500);
  expect(await server.discord.send("20", text, { replyTo: "90" })).toEqual(["201", "202"]);
  expect(server.requests).toHaveLength(2);
  const bodies = server.requests.map((request) => JSON.parse(String(request.body)));
  expect(bodies.map((body) => body.message_reference)).toEqual([
    { message_id: "90", channel_id: "20", fail_if_not_exists: true },
    undefined,
  ]);
  expect(bodies.map((body) => body.content).join("")).toBe(text);
  for (const body of bodies) expect(body.allowed_mentions).toEqual({ parse: [] });
  expect(server.created.map((posted) => posted.channel)).toEqual(["20", "20"]);
});
