import { expect, test } from "bun:test";
import { Discord } from "../src/messenger/discord.ts";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";
import { queuedWorld, settle } from "./discord-inbound-live-fakes.ts";
import { fakeClock } from "./fakes.ts";

test("ten quiet channels request only one head each and never rewrite their cursors", async () => {
  const channels = Array.from({ length: 10 }, (_, i) => String(i + 20));
  const history = channels.flatMap((channel_id) =>
    Array.from({ length: 100 }, (_, i) => ownerMessage(String(1000 - i), { channel_id, content: "x".repeat(2000) })),
  );
  const world = discordRestWorld(history);
  const stores = new Map(channels.map((id) => [id, memoryDiscordCursor("1000")]));
  const intake = await discordInbound(
    world.discord,
    (id) => {
      const cursor = stores.get(id);
      if (!cursor) throw new Error("unexpected channel");
      return cursor.store;
    },
    { ownerId: "10", channelIds: channels },
  );
  world.requests.length = 0;
  await intake.poll(() => {
    throw new Error("quiet channel emitted");
  });
  expect(world.requests).toHaveLength(10);
  expect(world.requests.map((request) => new URL(request.url).searchParams.get("limit"))).toEqual(Array(10).fill("1"));
  expect([...stores.values()].every((cursor) => cursor.saved.length === 0 && cursor.store.load() === "1000")).toBe(
    true,
  );
});

for (const latest of [undefined, "99", "100"]) {
  test(`an empty, deleted or unchanged head (${latest}) leaves cursor 100 intact`, async () => {
    const world = discordRestWorld(latest ? [ownerMessage(latest)] : []);
    const cursor = memoryDiscordCursor("100");
    const intake = await discordInbound(world.discord, () => cursor.store, { ownerId: "10", channelIds: ["20"] });
    world.requests.length = 0;
    await intake.poll(() => {
      throw new Error("old head emitted");
    });
    expect(world.requests).toHaveLength(1);
    expect(new URL(world.requests[0]!.url).searchParams.get("limit")).toBe("1");
    expect(cursor.saved).toEqual([]);
    expect(cursor.store.load()).toBe("100");
  });
}

for (const change of ["deleted", "newer"] as const) {
  test(`a head ${change} between probe and drain preserves received messages and ordering`, async () => {
    const limits: string[] = [];
    const discord = new Discord(
      async (request) => {
        const url = new URL(request.url);
        let body: unknown;
        if (url.pathname.endsWith("/users/@me")) body = { id: "99", bot: true };
        else if (url.pathname.endsWith("/applications/@me")) body = { flags: 1 << 18 };
        else if (url.pathname.endsWith("/channels/20")) body = { id: "20", type: 0 };
        else {
          const limit = url.searchParams.get("limit");
          if (!url.pathname.endsWith("/channels/20/messages") || !limit) throw new Error("unexpected route");
          limits.push(limit);
          body =
            limit === "1"
              ? [ownerMessage("101")]
              : change === "deleted"
                ? [ownerMessage("100")]
                : [ownerMessage("102"), ownerMessage("101"), ownerMessage("100")];
        }
        return { status: 200, headers: {}, body: JSON.stringify(body) };
      },
      fakeClock(0),
      "offline",
    );
    const cursor = memoryDiscordCursor("100");
    const intake = await discordInbound(discord, () => cursor.store, { ownerId: "10", channelIds: ["20"] });
    limits.length = 0;
    const emitted: string[] = [];
    await intake.poll((message) => emitted.push(message.message));
    expect(limits).toEqual(["1", "100"]);
    expect(emitted).toEqual(change === "deleted" ? ["101"] : ["101", "102"]);
    expect(cursor.saved).toEqual(emitted);
  });
}

test("a foreign-channel head fails before the quiet shortcut and does not move the cursor", async () => {
  const world = discordRestWorld([ownerMessage("100")]);
  const cursor = memoryDiscordCursor("100");
  const intake = await discordInbound(world.discord, () => cursor.store, { ownerId: "10", channelIds: ["20"] });
  world.state.responses.set("/channels/20/messages", JSON.stringify([ownerMessage("99", { channel_id: "21" })]));
  await expect(intake.poll(() => {})).rejects.toThrow("does not match");
  expect(cursor.saved).toEqual([]);
});

for (const explicit of [false, true]) {
  for (const status of [403, 404]) {
    test(`head HTTP ${status} remains ${explicit ? "fatal for explicit channels" : "skippable only for discovered channels"}`, async () => {
      const world = discordRestWorld([ownerMessage("100")]);
      world.state.guilds = [{ id: "5", channels: ["20"], threads: [] }];
      const cursor = memoryDiscordCursor("100");
      const intake = await discordInbound(world.discord, () => cursor.store, {
        ownerId: "10",
        channelIds: explicit ? ["20"] : [],
        all: !explicit,
      });
      world.state.failure.set("/channels/20/messages", status);
      if (explicit) await expect(intake.poll(() => {})).rejects.toThrow();
      else {
        await intake.poll(() => {});
        expect(intake.channels()).not.toContain("20");
      }
      expect(cursor.store.load()).toBe("100");
      expect(cursor.saved).toEqual([]);
    });
  }
}

for (const explicit of [false, true]) {
  for (const [fault, body] of [
    ["json", "{"],
    ["page", "{}"],
    ["message", "[null]"],
    ["id", '[{"id":"bad"}]'],
    ["oversized", JSON.stringify([ownerMessage("100"), ownerMessage("99")])],
    ["channel", JSON.stringify([ownerMessage("99", { channel_id: "21" })])],
  ] as const) {
    test(`a ${fault} head is fatal before the quiet shortcut for ${explicit ? "explicit" : "discovered"} channels`, async () => {
      const world = discordRestWorld([ownerMessage("100")]);
      world.state.guilds = [{ id: "5", channels: ["20"], threads: [] }];
      const cursor = memoryDiscordCursor("100");
      const intake = await discordInbound(world.discord, () => cursor.store, {
        ownerId: "10",
        channelIds: explicit ? ["20"] : [],
        all: !explicit,
      });
      world.requests.length = 0;
      world.state.responses.set("/channels/20/messages", body);
      await expect(intake.poll(() => {})).rejects.toMatchObject({
        status: 502,
        code: "DISCORD_INBOUND_PROTOCOL_ERROR",
      });
      expect(world.requests.map((request) => new URL(request.url).searchParams.get("limit"))).toEqual(["1"]);
      expect(intake.channels()).toEqual(["20"]);
      expect(cursor.saved).toEqual([]);
      expect(cursor.store.load()).toBe("100");
    });
  }
}

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

for (const head of [undefined, "99", "107"]) {
  posix(`a quiet REST head (${head}) leaves retained older owners available to the admitted FIFO`, async () => {
    const world = queuedWorld({
      history: head ? [ownerMessage(head)] : [],
      messages: [ownerMessage("105"), ownerMessage("109")],
      cursors: { "20": "107" },
      admissions: { "105": "102", "109": "107" },
    });
    await world.start();
    await settle();
    expect(world.received).toEqual(["20:105", "20:109"]);
    expect(world.saves).toEqual(["20:107", "20:109"]);
    expect(world.cursor()).toBe("109");
    expect(world.queue().first()).toBeNull();
    expect(
      world.rest.requests.map((request) => new URL(request.url).searchParams.get("limit")).filter(Boolean),
    ).toEqual(["1", "1"]);
  });
}
