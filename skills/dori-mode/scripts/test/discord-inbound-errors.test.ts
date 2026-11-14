import { expect, test } from "bun:test";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";

const options = { ownerId: "10", channelIds: ["20"] };

test("authentication and channel permissions fail initialization with actionable sanitized errors", async () => {
  for (const [path, status] of [
    ["/users/@me", 401],
    ["/channels/20/messages", 403],
    ["/channels/20/messages", 404],
  ] as const) {
    const world = discordRestWorld([ownerMessage("101")]);
    const cursor = memoryDiscordCursor("100");
    world.state.failure.set(path, status);
    const error: unknown = await discordInbound(world.discord, () => cursor.store, options).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(MessengerError);
    expect((error as MessengerError).status).toBe(status);
    expect((error as Error).message).not.toMatch(/private|diagnostic|unit-private-token|Authorization/);
    expect(cursor.saved).toEqual([]);
    expect(cursor.store.load()).toBe("100");
  }
});

test("only authenticated bots with Message Content Intent initialize owner intake", async () => {
  const user = discordRestWorld();
  user.state.bot = false;
  await expect(discordInbound(user.discord, () => memoryDiscordCursor().store, options)).rejects.toThrow(
    MessengerError,
  );
  expect(user.requests).toHaveLength(1);
  const self = discordRestWorld();
  await expect(
    discordInbound(self.discord, () => memoryDiscordCursor().store, { ownerId: "99", channelIds: ["20"] }),
  ).rejects.toThrow(MessengerError);
  for (const flags of [0, 1 << 17, Number.NaN]) {
    const world = discordRestWorld();
    world.state.flags = flags;
    const cursor = memoryDiscordCursor();
    await expect(discordInbound(world.discord, () => cursor.store, options)).rejects.toThrow(MessengerError);
    expect(cursor.saved).toEqual([]);
    expect(world.requests).toHaveLength(2);
  }
  for (const flags of [1 << 18, 1 << 19]) {
    const world = discordRestWorld();
    world.state.flags = flags;
    const cursor = memoryDiscordCursor();
    await discordInbound(world.discord, () => cursor.store, options);
    expect(cursor.store.load()).toBe("0");
  }
});

test("missing owner content is actionable and remains uncommitted", async () => {
  const message = ownerMessage("101");
  delete message.content;
  const world = discordRestWorld([message]);
  const cursor = memoryDiscordCursor("100");
  const intake = await discordInbound(world.discord, () => cursor.store, options);
  const received: string[] = [];
  await expect(intake.poll((inbound) => received.push(inbound.message))).rejects.toThrow(MessengerError);
  expect(received).toEqual([]);
  expect(cursor.store.load()).toBe("100");
  expect(cursor.saved).toEqual([]);
});

test("a history endpoint that does not advance fails without delivery or cursor loss", async () => {
  const world = discordRestWorld(Array.from({ length: 150 }, (_, index) => ownerMessage(String(index + 1))));
  const cursor = memoryDiscordCursor("0");
  const intake = await discordInbound(world.discord, () => cursor.store, options);
  world.state.stuckBefore = true;
  const received: string[] = [];
  await expect(intake.poll((message) => received.push(message.message))).rejects.toThrow(MessengerError);
  expect(received).toEqual([]);
  expect(cursor.saved).toEqual([]);
  expect(cursor.store.load()).toBe("0");
});

test("disappearing state and a mismatched channel cannot silently rebaseline or emit unrelated history", async () => {
  const world = discordRestWorld([ownerMessage("101")]);
  const cursor = memoryDiscordCursor("100");
  const intake = await discordInbound(world.discord, () => cursor.store, options);
  cursor.store.load = () => undefined;
  const requests = world.requests.length;
  await expect(intake.poll(() => {})).rejects.toThrow(MessengerError);
  expect(world.requests).toHaveLength(requests);
  expect(cursor.saved).toEqual([]);
  const foreign = discordRestWorld([ownerMessage("100", { channel_id: "21", content: "private foreign history" })]);
  foreign.state.mixChannels = true;
  const fresh = memoryDiscordCursor();
  await expect(discordInbound(foreign.discord, () => fresh.store, options)).rejects.toThrow(MessengerError);
  expect(fresh.saved).toEqual([]);
});
