import { expect, spyOn, test } from "bun:test";
import { DiscordChannels, inboundContext } from "../src/messenger/discord-channels.ts";
import { type DiscordInbound, formatDiscordInbound, formatInboundContext } from "../src/messenger/discord-inbound.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { queuedWorld, settle } from "./discord-inbound-live-fakes.ts";

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

for (const fault of ["emit", "save", "ack"] as const)
  posix(`${fault} failure stops merged recovery before 107 and preserves durable 105 across reopen`, async () => {
    const world = await queuedWorld({
      history: [ownerMessage("107")],
      messages: [ownerMessage("105"), ownerMessage("109")],
    });
    const lookup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    world.rest.state.responses.set(
      "/channels/20",
      JSON.stringify({ id: "20", type: 11, name: "task", parent_id: "30" }),
    );
    world.rest.state.responses.set("/channels/30", JSON.stringify({ id: "30", type: 0, name: "dev", topic: "Work" }));
    const purposes = new DiscordChannels(world.dir);
    await purposes.set("20", "one task", "task", 0);
    await purposes.set("30", "development", "dev", 0);
    const where = inboundContext(world.rest.discord, purposes, () => 0);
    const failure = new Error(`${fault} failed`);
    let broken = true;
    const acknowledge = world.queue().acknowledge;
    const ack = spyOn(world.queue(), "acknowledge").mockImplementation((channel, message) => {
      if (broken && fault === "ack" && message === "105") throw failure;
      acknowledge(channel, message);
    });
    const groups: string[] = [];
    const emit = async (message: DiscordInbound) => {
      world.rest.state.blocked.set("/channels/20", lookup.promise);
      entered.resolve();
      const context = await where(message.channel);
      if (broken && fault === "emit" && message.message === "105") throw failure;
      groups.push(`${formatDiscordInbound(message)}\n${formatInboundContext(message, context)}`);
    };
    const storeFor = (channel: string, seed?: boolean) => {
      const store = world.queue().storeFor(channel, seed);
      return {
        load: store.load,
        save: (id: string) => {
          if (broken && fault === "save" && id === "105") throw failure;
          store.save(id);
        },
      };
    };
    try {
      const run = await world.start(emit, storeFor);
      await entered.promise;
      expect(world.cursor()).toBe("102");
      expect(world.received).toEqual([]);
      expect(world.saves).toEqual([]);
      const pending = world.queue().nextOwner("20", "10", "105", "0", 0);
      expect(JSON.parse(pending!.payload).id).toBe("105");
      expect(pending?.admittedAfter).toBe("102");
      lookup.resolve();
      expect(await run.outcome).toBe(failure);
      expect(world.cursor()).toBe(fault === "ack" ? "105" : "102");
      expect(world.received).toEqual(fault === "emit" ? [] : ["20:105"]);
      expect(world.queue().first()?.kind).toBe("sync");
      expect(JSON.parse(world.queue().nextOwner("20", "10", "105", "0", 0)!.payload).id).toBe("105");
      expect(run.socket.closed).toBe(true);
      broken = false;
      ack.mockRestore();
      await world.restart(emit, storeFor);
      await settle();
      const ids = fault === "save" ? ["105", "105", "107", "109"] : ["105", "107", "109"];
      expect(world.received).toEqual(ids.map((id) => `20:${id}`));
      const context = JSON.stringify({
        channel: { id: "30", name: "dev", topic: "Work", purpose: "development" },
        thread: { id: "20", name: "task", purpose: "one task" },
      });
      expect(groups).toEqual(
        ids.map(
          (id) =>
            `INBOUND discord 20 ${id} from=owner ref=- "owner ${id}"\nINBOUND_CONTEXT discord 20 ${id} ${context}`,
        ),
      );
      expect(world.cursor()).toBe("109");
      expect(world.queue().first()).toBeNull();
    } finally {
      lookup.resolve();
      ack.mockRestore();
    }
  });

posix("queued owner conversion failure is not hidden by a newer filtered REST checkpoint", async () => {
  const missing = ownerMessage("105");
  delete missing.content;
  const world = await queuedWorld({
    history: [ownerMessage("107", { author: { id: "11" } })],
    messages: [missing, ownerMessage("109")],
  });
  const run = await world.start();
  expect(await run.outcome).toBeInstanceOf(MessengerError);
  expect(world.received).toEqual([]);
  expect(world.saves).toEqual([]);
  expect(world.cursor()).toBe("102");
  expect(JSON.parse(world.queue().nextOwner("20", "10", "105", "0", 0)!.payload).id).toBe("105");
  expect(run.socket.closed).toBe(true);
});

for (const fault of ["save", "ack"] as const)
  posix(
    `late 105 ${fault} failure retains its admission and repeats only inside its acknowledgement window`,
    async () => {
      const world = await queuedWorld({
        cursors: { "20": "107" },
        admissions: { "105": "102", "109": "107" },
        history: [ownerMessage("107")],
        messages: [ownerMessage("105"), ownerMessage("109")],
      });
      const failure = new Error(`late ${fault} failed`);
      let broken = true;
      const acknowledge = world.queue().acknowledge;
      const ack = spyOn(world.queue(), "acknowledge").mockImplementation((channel, message) => {
        if (broken && fault === "ack" && message === "105") throw failure;
        acknowledge(channel, message);
      });
      const storeFor = (channel: string, seed?: boolean) => {
        const store = world.queue().storeFor(channel, seed);
        return {
          load: store.load,
          save: (id: string) => {
            if (broken && fault === "save" && id === "107") throw failure;
            store.save(id);
          },
        };
      };
      try {
        const run = await world.start(() => settle(), storeFor);
        expect(await run.outcome).toBe(failure);
        expect(world.received).toEqual(["20:105"]);
        expect(world.cursor()).toBe("107");
        expect(world.queue().first()?.admittedAfter).toBe("102");
        broken = false;
        ack.mockRestore();
        await world.restart(undefined, storeFor);
        await settle();
        expect(world.received).toEqual(["20:105", "20:105", "20:109"]);
        expect(world.saves).toEqual(fault === "ack" ? ["20:107", "20:107", "20:109"] : ["20:107", "20:109"]);
        expect(world.cursor()).toBe("109");
        expect(world.queue().first()).toBeNull();
      } finally {
        ack.mockRestore();
      }
    },
  );

posix("stop before a late owner's acknowledgement retains it without draining its successor", async () => {
  const world = await queuedWorld({
    messages: [ownerMessage("105"), ownerMessage("109")],
    cursors: { "20": "107" },
    admissions: { "105": "102", "109": "107" },
    sync: false,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const run = await world.start(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    run.live.close();
    release.resolve();
    expect(await run.outcome).toBeUndefined();
    expect(world.received).toEqual(["20:105"]);
    expect(world.cursor()).toBe("107");
    expect(JSON.parse(world.queue().first()!.payload).id).toBe("105");
    expect(world.queue().first()?.admittedAfter).toBe("102");
    await world.restart();
    await settle();
    expect(world.received).toEqual(["20:105", "20:105", "20:109"]);
    expect(world.saves).toEqual(["20:107", "20:107", "20:109"]);
    expect(world.cursor()).toBe("109");
    expect(world.queue().first()).toBeNull();
  } finally {
    release.resolve();
  }
});
