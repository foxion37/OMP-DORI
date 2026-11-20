import { expect, test } from "bun:test";
import { DiscordChannels, inboundContext } from "../src/messenger/discord-channels.ts";
import { discordInbound, formatDiscordInbound, formatInboundContext } from "../src/messenger/discord-inbound.ts";
import { type DiscordInboundLive, discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { discordRestWorld, ownerMessage } from "./discord-inbound-fakes.ts";
import { settle } from "./discord-inbound-live-fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { withState } from "./fakes.ts";

const options = { ownerId: "10", channelIds: ["20"] };

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

// Use the actual queue, atomic cursor store, backfill batching and asynchronous context lookup together.
posix("a queued backfill awaits context before checkpointing and draining live successors", async () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  const lookup = Promise.withResolvers<void>();
  let live: DiscordInboundLive | undefined;
  try {
    queue.storeFor("20").save("100");
    const rest = discordRestWorld([
      ownerMessage("101", { author: { id: "11" } }),
      ownerMessage("102"),
      ownerMessage("103", { author: { id: "11" } }),
      ownerMessage("104", { author: { id: "11" } }),
      ownerMessage("105"),
      ownerMessage("106", { author: { id: "11" } }),
      ownerMessage("107", { author: { id: "11" } }),
    ]);
    rest.state.responses.set("/channels/20", JSON.stringify({ id: "20", type: 11, name: "task", parent_id: "30" }));
    rest.state.responses.set("/channels/30", JSON.stringify({ id: "30", type: 0, name: "dev", topic: "Project work" }));
    const purposes = new DiscordChannels(state.dir);
    await purposes.set("20", "one task", "task", 0);
    await purposes.set("30", "development", "dev", 0);
    const where = inboundContext(rest.discord, purposes, () => 0);
    const saves: string[] = [];
    const intake = await discordInbound(
      rest.discord,
      (channel) => {
        const store = queue.storeFor(channel);
        return {
          load: store.load,
          save: (id) => {
            store.save(id);
            saves.push(id);
          },
        };
      },
      options,
    );
    rest.state.blocked.set("/channels/20", lookup.promise);
    const socket = new FakeGateway("offline");
    const entered = Promise.withResolvers<void>();
    const attempts: string[] = [];
    const groups: string[] = [];
    live = discordInboundLive(
      intake,
      () => socket,
      "offline",
      gatewayTimers().clock,
      async (message) => {
        attempts.push(`${message.message}:${queue.storeFor("20").load()}`);
        entered.resolve();
        const context = await where(message.channel);
        groups.push(`${formatDiscordInbound(message)}\n${formatInboundContext(message, context)}`);
      },
      () => {},
      queue,
    );
    socket.hello();
    socket.ready(1);
    await entered.promise;
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("105") });
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: ownerMessage("108", { author: { id: "11" } }) });
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("109") });
    expect([attempts, groups, saves]).toEqual([["102:100"], [], []]);
    expect(queue.storeFor("20").load()).toBe("100");
    expect(queue.first()?.kind).toBe("sync");
    lookup.resolve();
    await settle();
    const context = JSON.stringify({
      channel: { id: "30", name: "dev", topic: "Project work", purpose: "development" },
      thread: { id: "20", name: "task", purpose: "one task" },
    });
    expect(groups).toEqual(
      ["102", "105", "109"].map(
        (id) => `INBOUND discord 20 ${id} from=owner ref=- "owner ${id}"\nINBOUND_CONTEXT discord 20 ${id} ${context}`,
      ),
    );
    expect(attempts).toEqual(["102:100", "105:102", "109:108"]);
    expect(saves).toEqual(["102", "105", "107", "108", "109"]);
    expect(queue.storeFor("20").load()).toBe("109");
    expect(queue.first()).toBeNull();
  } finally {
    lookup.resolve();
    live?.close();
    await live?.done;
    queue.close();
    state.done();
  }
});

for (const fault of ["emit", "save"] as const)
  posix(`a late ${fault} failure retains the FIFO and replays every successor after restart`, async () => {
    const state = withState();
    let queue = discordInboundQueue(state.dir);
    const release = Promise.withResolvers<void>();
    let live: DiscordInboundLive | undefined;
    try {
      queue.push("message", ownerMessage("101"));
      queue.push("message", ownerMessage("102"));
      const rest = discordRestWorld([]);
      const failure = new Error(`late ${fault} failure`);
      let intake = await discordInbound(
        rest.discord,
        (channel) => {
          const store = queue.storeFor(channel);
          return {
            load: store.load,
            save: (id) => {
              if (fault === "save" && id === "101") throw failure;
              store.save(id);
            },
          };
        },
        options,
      );
      let socket = new FakeGateway("offline");
      const entered = Promise.withResolvers<void>();
      const attempts: string[] = [];
      live = discordInboundLive(
        intake,
        () => socket,
        "offline",
        gatewayTimers().clock,
        async (message) => {
          attempts.push(message.message);
          entered.resolve();
          await release.promise;
          if (fault === "emit") throw failure;
        },
        () => {},
        queue,
      );
      const outcome = live.done.catch((error: unknown) => error);
      await entered.promise;
      socket.hello();
      socket.ready(1);
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("103") });
      expect(attempts).toEqual(["101"]);
      expect(queue.storeFor("20").load()).toBe("100");
      expect(JSON.parse(queue.first()!.payload).id).toBe("101");
      release.resolve();
      expect(await outcome).toBe(failure);
      expect(attempts).toEqual(["101"]);
      expect(queue.storeFor("20").load()).toBe("100");
      expect(JSON.parse(queue.first()!.payload).id).toBe("101");
      expect(socket.closed).toBe(true);
      queue.close();
      queue = discordInboundQueue(state.dir);
      intake = await discordInbound(rest.discord, queue.storeFor, options);
      socket = new FakeGateway("offline");
      const received: string[] = [];
      live = discordInboundLive(
        intake,
        () => socket,
        "offline",
        gatewayTimers().clock,
        (message) => Promise.resolve(received.push(message.message)),
        () => {},
        queue,
      );
      await settle();
      expect(received).toEqual(["101", "102", "103"]);
      expect(queue.storeFor("20").load()).toBe("103");
      expect(queue.first()).toBeNull();
    } finally {
      release.resolve();
      live?.close();
      await live?.done.catch(() => {});
      queue.close();
      state.done();
    }
  });
