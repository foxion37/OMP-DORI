import { expect, test } from "bun:test";
import { DiscordChannels, inboundContext } from "../src/messenger/discord-channels.ts";
import { discordInbound, formatDiscordInbound, formatInboundContext } from "../src/messenger/discord-inbound.ts";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";
import { withState } from "./fakes.ts";

const options = { ownerId: "10", channelIds: ["20"] };
const ignored = (id: string) => ownerMessage(id, { author: { id: "11" } });

// POSIX-only: the Discord cursor store requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

posix("1,000 filtered messages across overlapping pages use one durable checkpoint", async () => {
  const state = withState();
  try {
    const store = fileDiscordInboundStore(state.dir, "20");
    store.save("100");
    const world = discordRestWorld(Array.from({ length: 1_000 }, (_, i) => ignored(String(i + 101))));
    world.state.overlap = true;
    const saves: string[] = [];
    const intake = await discordInbound(
      world.discord,
      () => ({
        load: store.load,
        save: (id) => {
          store.save(id);
          saves.push(id);
        },
      }),
      options,
    );
    await intake.poll(() => {
      throw new Error("filtered message emitted");
    });
    expect(saves).toEqual(["1100"]);
    expect(fileDiscordInboundStore(state.dir, "20").load()).toBe("1100");
    await intake.poll(() => {
      throw new Error("filtered message replay emitted");
    });
    expect(saves).toEqual(["1100"]);
  } finally {
    state.done();
  }
});

test("each owner is checkpointed before the next emit and a trailing filtered run saves once", async () => {
  const world = discordRestWorld([
    ignored("101"),
    ownerMessage("102"),
    ignored("103"),
    ignored("104"),
    ownerMessage("105"),
    ignored("106"),
    ignored("107"),
  ]);
  const cursor = memoryDiscordCursor("100");
  const intake = await discordInbound(world.discord, () => cursor.store, options);
  const emitted: string[] = [];
  await intake.poll((message) => {
    expect(cursor.store.load()).toBe(message.message === "102" ? "100" : "102");
    emitted.push(message.message);
  });
  expect(emitted).toEqual(["102", "105"]);
  expect(cursor.saved).toEqual(["102", "105", "107"]);
  await intake.accept(ignored("108"), () => {
    throw new Error("filtered live emit");
  });
  expect(cursor.saved).toEqual(["102", "105", "107", "108"]);
});

test("an emitter failure rechecks the filtered prefix but never commits past the failed owner", async () => {
  const world = discordRestWorld([
    ownerMessage("101"),
    ignored("102"),
    ignored("103"),
    ownerMessage("104"),
    ignored("105"),
  ]);
  const cursor = memoryDiscordCursor("100");
  let intake = await discordInbound(world.discord, () => cursor.store, options);
  const emitted: string[] = [];
  await expect(
    intake.poll((message) => {
      if (message.message === "104") throw new Error("emit failed");
      emitted.push(message.message);
    }),
  ).rejects.toThrow("emit failed");
  expect(cursor.saved).toEqual(["101"]);
  intake = await discordInbound(world.discord, () => cursor.store, options);
  await intake.poll((message) => emitted.push(message.message));
  expect(emitted).toEqual(["101", "104"]);
  expect(cursor.saved).toEqual(["101", "104", "105"]);
});

for (const failed of ["102", "104"]) {
  test(`a failed ${failed === "102" ? "owner" : "trailing filtered"} save stops at the previous durable cursor`, async () => {
    const world = discordRestWorld([ignored("101"), ownerMessage("102"), ignored("103"), ignored("104")]);
    const cursor = memoryDiscordCursor("100");
    let broken = true;
    const intake = await discordInbound(
      world.discord,
      () => ({
        load: cursor.store.load,
        save: (id) => {
          if (broken && id === failed) throw new Error("save failed");
          cursor.store.save(id);
        },
      }),
      options,
    );
    const emitted: string[] = [];
    await expect(intake.poll((message) => emitted.push(message.message))).rejects.toThrow("save failed");
    expect(cursor.store.load()).toBe(failed === "102" ? "100" : "102");
    expect(emitted).toEqual(["102"]);
    broken = false;
    await intake.poll((message) => emitted.push(message.message));
    expect(emitted).toEqual(failed === "102" ? ["102", "102"] : ["102"]);
    expect(cursor.saved).toEqual(["102", "104"]);
  });
}

test("filtered batches remain per-channel and a later-page error saves nothing", async () => {
  const world = discordRestWorld(Array.from({ length: 150 }, (_, i) => ignored(String(i + 1))));
  world.state.messages.push(ignored("151"), ownerMessage("201", { channel_id: "21" }));
  const first = memoryDiscordCursor("0");
  const second = memoryDiscordCursor("200");
  const intake = await discordInbound(world.discord, (id) => (id === "20" ? first.store : second.store), {
    ownerId: "10",
    channelIds: ["20", "21"],
  });
  world.state.failBefore = true;
  await expect(intake.poll(() => {})).rejects.toThrow();
  expect(first.saved).toEqual([]);
  expect(second.saved).toEqual([]);
  world.state.failBefore = false;
  const emitted: string[] = [];
  await intake.poll((message) => emitted.push(`${message.channel}:${message.message}`));
  expect(first.saved).toEqual(["151"]);
  expect(second.saved).toEqual(["201"]);
  expect(emitted).toEqual(["21:201"]);
});

for (const failed of [false, true]) {
  test(`async context ${failed ? "failure stops before trailing saves" : "emits in owner checkpoint order"}`, async () => {
    const state = withState();
    const lookup = Promise.withResolvers<void>();
    try {
      const world = discordRestWorld([
        ignored("101"),
        ownerMessage("102"),
        ignored("103"),
        ignored("104"),
        ownerMessage("105"),
        ignored("106"),
        ignored("107"),
      ]);
      world.state.responses.set("/channels/20", JSON.stringify({ id: "20", type: 11, name: "task", parent_id: "30" }));
      world.state.responses.set(
        "/channels/30",
        JSON.stringify({ id: "30", type: 0, name: "dev", topic: "Project work" }),
      );
      const purposes = new DiscordChannels(state.dir);
      await purposes.set("20", "one task", "task", 0);
      await purposes.set("30", "development", "dev", 0);
      const where = inboundContext(world.discord, purposes, () => 0);
      const cursor = memoryDiscordCursor("100");
      const intake = await discordInbound(world.discord, () => cursor.store, options);
      world.state.blocked.set("/channels/20", lookup.promise);
      const entered = Promise.withResolvers<void>();
      const attempts: string[] = [];
      const groups: string[] = [];
      const poll = intake.poll(async (message) => {
        attempts.push(`${message.message}:${cursor.store.load()}`);
        entered.resolve();
        const context = await where(message.channel);
        if (failed && message.message === "105") throw new Error("context emit failed");
        groups.push(`${formatDiscordInbound(message)}\n${formatInboundContext(message, context)}`);
      });
      let emissionFailure: unknown;
      const outcome = poll.catch((error: unknown) => {
        emissionFailure = error;
      });
      await entered.promise;
      const pending = [attempts.slice(), groups.slice(), cursor.saved.slice()];
      lookup.resolve();
      await outcome;
      expect(emissionFailure).toEqual(failed ? new Error("context emit failed") : undefined);
      expect(pending).toEqual([["102:100"], [], []]);
      expect(attempts).toEqual(["102:100", "105:102"]);
      expect(cursor.saved).toEqual(failed ? ["102"] : ["102", "105", "107"]);
      const context = JSON.stringify({
        channel: { id: "30", name: "dev", topic: "Project work", purpose: "development" },
        thread: { id: "20", name: "task", purpose: "one task" },
      });
      expect(groups).toEqual(
        (failed ? ["102"] : ["102", "105"]).map(
          (id) =>
            `INBOUND discord 20 ${id} from=owner ref=- "owner ${id}"\nINBOUND_CONTEXT discord 20 ${id} ${context}`,
        ),
      );
    } finally {
      lookup.resolve();
      state.done();
    }
  });
}
