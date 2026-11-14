import { expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { discordInbound, type DiscordInbound } from "../src/messenger/discord-inbound.ts";
import { discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { discordRestWorld, ownerMessage } from "./discord-inbound-fakes.ts";
import { settle } from "./discord-inbound-live-fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { withState } from "./fakes.ts";

const cursorWorld = async (explicit: boolean, onEmit?: (message: DiscordInbound) => void) => {
  const state = withState();
  const rest = discordRestWorld([ownerMessage("100"), ownerMessage("100", { channel_id: "21" })]);
  rest.state.guilds = [{ id: "5", channels: ["20", "21"], threads: [] }];
  const storeFor = (channel: string) => fileDiscordInboundStore(state.dir, channel);
  const intake = await discordInbound(rest.discord, storeFor, {
    ownerId: "10",
    channelIds: explicit ? ["20"] : [],
    all: true,
  }).catch((error: unknown) => {
    state.done();
    throw error;
  });
  const timers = gatewayTimers();
  const sockets: FakeGateway[] = [];
  const received: string[] = [];
  const live = discordInboundLive(
    intake,
    (url) => {
      const socket = new FakeGateway(url);
      sockets.push(socket);
      return socket;
    },
    "unit-private-token",
    timers.clock,
    (message) => {
      onEmit?.(message);
      received.push(`${message.channel}:${message.message}`);
    },
    () => {},
  );
  let finished = false;
  const outcome = live.done.then(
    () => {
      finished = true;
      return undefined;
    },
    (error: unknown) => {
      finished = true;
      return error;
    },
  );
  const socket = sockets[0];
  if (!socket) throw new Error("gateway did not open");
  return {
    rest,
    intake,
    live,
    socket,
    sockets,
    timers,
    received,
    outcome,
    finished: () => finished,
    cursor: (channel: string) => storeFor(channel).load(),
    path: (channel: string) => join(state.dir, "discord-inbound", `${channel}.json`),
    async close() {
      live.close();
      await outcome;
      state.done();
    },
  };
};

for (const explicit of [false, true]) {
  for (const fault of ["missing owner content", 403, 404] as const) {
    const scope = explicit ? "explicit" : "discovered";
    const label = typeof fault === "number" ? `emitter ${fault}` : fault;
    test(`${scope} ${label} stops backfill before queued 102 and retains cursor 100`, async () => {
      const refused = typeof fault === "number" ? new MessengerError("delivery refused", fault) : undefined;
      const world = await cursorWorld(explicit, (message) => {
        if (message.message === "101" && refused) throw refused;
      });
      const response = Promise.withResolvers<void>();
      try {
        const history = ownerMessage("101");
        if (fault === "missing owner content") delete history.content;
        world.rest.state.messages.push(history);
        world.rest.state.blocked.set("/channels/20/messages", response.promise);
        world.socket.hello();
        world.socket.ready(1);
        await settle();
        world.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("102") });
        await settle();
        expect(world.received).toEqual([]);
        expect(world.cursor("20")).toBe("100");
        response.resolve();
        await settle();
        expect({
          finished: world.finished(),
          received: world.received,
          cursor: world.cursor("20"),
          closed: world.socket.closed,
          timers: world.timers.pending.size,
        }).toEqual({ finished: true, received: [], cursor: "100", closed: true, timers: 0 });
        const error = await world.outcome;
        expect(error).toBeInstanceOf(MessengerError);
        expect((error as MessengerError).status).toBe(typeof fault === "number" ? fault : 403);
        if (refused) expect(error).toBe(refused);
        world.timers.advance(600_000);
        await settle();
        expect(world.received).toEqual([]);
        expect(world.cursor("20")).toBe("100");
        expect(world.sockets).toHaveLength(1);
      } finally {
        response.resolve();
        await world.close();
      }
    });
  }
}

for (const explicit of [false, true]) {
  for (const status of [403, 404]) {
    test(`remote ${status} history loss is ${explicit ? "fatal for an explicit target" : "skipped for a discovered target"}`, async () => {
      const world = await cursorWorld(explicit);
      try {
        world.rest.state.messages.push(ownerMessage("101"));
        world.rest.state.failure.set("/channels/20/messages", status);
        world.socket.hello();
        world.socket.ready(1);
        world.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("102", { channel_id: "21" }) });
        await settle();
        expect(world.cursor("20")).toBe("100");
        if (explicit) {
          expect(world.finished()).toBe(true);
          const error = await world.outcome;
          expect(error).toBeInstanceOf(MessengerError);
          expect((error as MessengerError).status).toBe(status);
          expect(world.received).toEqual([]);
          expect(world.cursor("21")).toBe("100");
          expect(world.socket.closed).toBe(true);
          expect(world.timers.pending.size).toBe(0);
        } else {
          expect(world.finished()).toBe(false);
          expect(world.received).toEqual(["21:102"]);
          expect(world.cursor("21")).toBe("102");
          expect(world.socket.closed).toBe(false);
          expect(world.intake.channels()).not.toContain("20");
          world.live.close();
          expect(await world.outcome).toBeUndefined();
          expect(world.timers.pending.size).toBe(0);
        }
      } finally {
        await world.close();
      }
    });
  }
}

for (const explicit of [false, true]) {
  test(`${explicit ? "explicit" : "discovered"} watched cursor deletion stops live intake without rebaselining`, async () => {
    const world = await cursorWorld(explicit);
    try {
      world.socket.hello();
      world.socket.ready(1);
      await settle();
      expect(world.cursor("20")).toBe("100");
      expect(world.finished()).toBe(false);
      unlinkSync(world.path("20"));
      const requests = world.rest.requests.length;
      world.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("101") });
      world.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: ownerMessage("102") });
      await settle();
      expect({
        finished: world.finished(),
        received: world.received,
        cursorExists: existsSync(world.path("20")),
        closed: world.socket.closed,
        timers: world.timers.pending.size,
      }).toEqual({ finished: true, received: [], cursorExists: false, closed: true, timers: 0 });
      const error = await world.outcome;
      expect(error).toBeInstanceOf(MessengerError);
      expect((error as MessengerError).status).toBe(0);
      expect(world.rest.requests).toHaveLength(requests);
      world.timers.advance(600_000);
      await settle();
      expect(existsSync(world.path("20"))).toBe(false);
      expect(world.received).toEqual([]);
      expect(world.sockets).toHaveLength(1);
    } finally {
      await world.close();
    }
  });
}

test("a first-seen scope-all channel still seeds its own cursor and deduplicates live messages", async () => {
  const world = await cursorWorld(false);
  try {
    world.socket.hello();
    world.socket.ready(1);
    await settle();
    expect(existsSync(world.path("50"))).toBe(false);
    for (const [seq, id] of [
      [2, "201"],
      [3, "201"],
      [4, "202"],
    ] as const) {
      world.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: seq, d: ownerMessage(id, { channel_id: "50" }) });
    }
    await settle();
    expect(world.received).toEqual(["50:201", "50:202"]);
    expect(world.cursor("50")).toBe("202");
    expect(world.finished()).toBe(false);
    expect(world.socket.closed).toBe(false);
  } finally {
    await world.close();
  }
});
