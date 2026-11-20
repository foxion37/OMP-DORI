import { expect, test } from "bun:test";
import { Discord } from "../src/messenger/discord.ts";
import { DiscordChannels, inboundContext } from "../src/messenger/discord-channels.ts";
import { discordInbound, formatDiscordInbound, formatInboundContext } from "../src/messenger/discord-inbound.ts";
import { type DiscordInboundLive, discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { discordRestWorld, ownerMessage } from "./discord-inbound-fakes.ts";
import { settle } from "./discord-inbound-live-fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { fakeClock, withState } from "./fakes.ts";

const options = { ownerId: "10", channelIds: ["20"] };
const ignored = (id: string) => ownerMessage(id, { author: { id: "11" } });

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

posix(
  "a deleted probe head keeps batched context delivery ahead of disk FIFO successors and quiet RESUMED",
  async () => {
    const state = withState();
    const queue = discordInboundQueue(state.dir);
    const lookup = Promise.withResolvers<void>();
    let live: DiscordInboundLive | undefined;
    try {
      queue.storeFor("20").save("100");
      const history = [ignored("101"), ownerMessage("102"), ignored("103"), ignored("104"), ownerMessage("105")];
      const limits: string[] = [];
      let channelReads = 0;
      const discord = new Discord(
        async (request) => {
          const url = new URL(request.url);
          let body: unknown;
          if (url.pathname.endsWith("/users/@me")) body = { id: "99", bot: true };
          else if (url.pathname.endsWith("/applications/@me")) body = { flags: 1 << 19 };
          else if (url.pathname.endsWith("/channels/20/messages")) {
            const limit = url.searchParams.get("limit");
            if (limit !== "1" && limit !== "100") throw new Error("unexpected history limit");
            limits.push(limit);
            if (limit === "1") body = history.slice(-1);
            else {
              // The received head disappears, and newer filtered messages arrive before the full read.
              history.splice(4, 1, ignored("106"), ignored("107"));
              body = [...history].reverse();
            }
          } else if (url.pathname.endsWith("/channels/20")) {
            if (++channelReads > 1) await lookup.promise; // Startup scope metadata is separate from awaited context.
            body = { id: "20", type: 11, name: "task", parent_id: "30" };
          } else if (url.pathname.endsWith("/channels/30")) body = { id: "30", type: 0, name: "dev" };
          else throw new Error("unexpected REST endpoint");
          return { status: 200, headers: {}, body: JSON.stringify(body) };
        },
        fakeClock(0),
        "offline",
      );
      const where = inboundContext(discord, new DiscordChannels(state.dir), () => 0);
      const saves: string[] = [];
      const intake = await discordInbound(
        discord,
        (channel, seed) => {
          const store = queue.storeFor(channel, seed);
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
      limits.length = 0;
      const entered = Promise.withResolvers<void>();
      const attempts: string[] = [];
      const groups: string[] = [];
      const sockets: FakeGateway[] = [];
      const timers = gatewayTimers();
      live = discordInboundLive(
        intake,
        () => {
          const socket = new FakeGateway("offline");
          sockets.push(socket);
          return socket;
        },
        "offline",
        timers.clock,
        async (message) => {
          attempts.push(`${message.message}:${queue.storeFor("20").load()}`);
          entered.resolve();
          const context = await where(message.channel);
          groups.push(`${formatDiscordInbound(message)}\n${formatInboundContext(message, context)}`);
        },
        () => {},
        queue,
      );
      const socket = sockets[0];
      if (!socket) throw new Error("gateway did not open");
      socket.hello();
      socket.ready(1);
      await entered.promise;
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("105") });
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: ignored("108") });
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("109") });
      expect(limits).toEqual(["1", "100"]);
      expect([attempts, groups, saves, queue.storeFor("20").load()]).toEqual([["102:100"], [], [], "100"]);
      expect(queue.first()?.kind).toBe("sync");
      lookup.resolve();
      await settle();
      const context = JSON.stringify({
        channel: { id: "30", name: "dev", purpose: null },
        thread: { id: "20", name: "task", purpose: null },
      });
      expect(groups).toEqual(
        ["102", "105", "109"].map(
          (id) =>
            `INBOUND discord 20 ${id} from=owner ref=- "owner ${id}"\nINBOUND_CONTEXT discord 20 ${id} ${context}`,
        ),
      );
      expect(attempts).toEqual(["102:100", "105:102", "109:108"]);
      expect(saves).toEqual(["102", "105", "107", "108", "109"]);
      expect(queue.storeFor("20").load()).toBe("109");
      expect(queue.first()).toBeNull();
      limits.length = 0;
      socket.disconnect(1006);
      timers.advance(10_000);
      const resumed = sockets[1];
      if (!resumed) throw new Error("gateway did not reconnect");
      resumed.hello();
      resumed.receive({ op: 0, t: "RESUMED", s: 5, d: {} });
      await settle();
      expect(resumed.frames[0]?.op).toBe(6);
      expect(limits).toEqual(["1"]);
      expect(attempts).toEqual(["102:100", "105:102", "109:108"]);
      expect(saves).toEqual(["102", "105", "107", "108", "109"]);
      expect(queue.first()).toBeNull();
    } finally {
      lookup.resolve();
      live?.close();
      await live?.done;
      queue.close();
      state.done();
    }
  },
);

for (const fault of ["emit", "save"] as const)
  posix(`a probed backfill ${fault} failure preserves owner checkpoints and the restart FIFO`, async () => {
    const state = withState();
    let queue = discordInboundQueue(state.dir);
    const release = Promise.withResolvers<void>();
    let live: DiscordInboundLive | undefined;
    try {
      queue.storeFor("20").save("100");
      const rest = discordRestWorld([
        ignored("101"),
        ownerMessage("102"),
        ignored("103"),
        ownerMessage("104"),
        ignored("105"),
      ]);
      const failure = new Error(`probed ${fault} failure`);
      let broken = true;
      const saves: string[] = [];
      const storeFor = (channel: string, seed?: boolean) => {
        const store = queue.storeFor(channel, seed);
        return {
          load: store.load,
          save: (id: string) => {
            if (broken && fault === "save" && id === "104") throw failure;
            store.save(id);
            saves.push(id);
          },
        };
      };
      let intake = await discordInbound(rest.discord, storeFor, options);
      rest.requests.length = 0;
      let socket = new FakeGateway("offline");
      const entered = Promise.withResolvers<void>();
      const received: string[] = [];
      live = discordInboundLive(
        intake,
        () => socket,
        "offline",
        gatewayTimers().clock,
        async (message) => {
          if (message.message === "104") {
            entered.resolve();
            await release.promise;
            if (fault === "emit") throw failure;
          }
          received.push(message.message);
        },
        () => {},
        queue,
      );
      const outcome = live.done.catch((error: unknown) => error);
      socket.hello();
      socket.ready(1);
      await entered.promise;
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("104") });
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: ignored("106") });
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("107") });
      expect(rest.requests.map((request) => new URL(request.url).searchParams.get("limit"))).toEqual(["1", "100"]);
      expect([received, saves, queue.storeFor("20").load()]).toEqual([["102"], ["102"], "102"]);
      expect(queue.first()?.kind).toBe("sync");
      release.resolve();
      expect(await outcome).toBe(failure);
      expect(received).toEqual(fault === "emit" ? ["102"] : ["102", "104"]);
      expect(saves).toEqual(["102"]);
      expect(queue.storeFor("20").load()).toBe("102");
      expect(queue.first()?.kind).toBe("sync");
      expect(socket.closed).toBe(true);
      queue.close();
      queue = discordInboundQueue(state.dir);
      broken = false;
      intake = await discordInbound(rest.discord, storeFor, options);
      rest.requests.length = 0;
      socket = new FakeGateway("offline");
      const recovered: string[] = [];
      live = discordInboundLive(
        intake,
        () => socket,
        "offline",
        gatewayTimers().clock,
        (message) => Promise.resolve(recovered.push(message.message)),
        () => {},
        queue,
      );
      await settle();
      expect(rest.requests.map((request) => new URL(request.url).searchParams.get("limit"))).toEqual(["1", "100"]);
      expect(recovered).toEqual(["104", "107"]);
      expect(saves).toEqual(["102", "104", "105", "106", "107"]);
      expect(queue.storeFor("20").load()).toBe("107");
      expect(queue.first()).toBeNull();
    } finally {
      release.resolve();
      live?.close();
      await live?.done.catch(() => {});
      queue.close();
      state.done();
    }
  });
