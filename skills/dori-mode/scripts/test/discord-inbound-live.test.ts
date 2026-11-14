import { expect, test } from "bun:test";
import { MessengerError } from "../src/messenger/http.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { liveWorld, settle } from "./discord-inbound-live-fakes.ts";

const options = { ownerId: "10", channelIds: ["20"] };

test("a live owner message is emitted at once, with the minimum intents and no presence override", async () => {
  const world = await liveWorld([ownerMessage("100")], options);
  const [socket] = world.sockets;
  if (!socket) throw new Error("gateway did not open");
  await world.connect(socket);
  const identify = socket.frames[0]?.d as { intents: number; presence?: unknown; token: string };
  expect(identify.intents).toBe((1 << 9) | (1 << 12) | (1 << 15));
  expect(identify.presence).toBeUndefined();
  expect(world.received).toEqual([]); // Cold start skips history, including the latest owner message.
  const requests = world.rest.requests.length;
  await world.dispatch(socket, ownerMessage("101"));
  expect(world.received).toEqual(["20:101"]);
  expect(world.rest.requests).toHaveLength(requests); // Delivered from the dispatch, not from a REST read.
  expect(world.cursor("20")).toBe("101");
  expect(world.logs.join("\n")).not.toContain("unit-private-token");
});

test("non-owner, bot, webhook, system and unwatched-channel messages are ignored but advance the cursor", async () => {
  const world = await liveWorld([], options, { "20": "100" });
  const [socket] = world.sockets;
  if (!socket) throw new Error("gateway did not open");
  await world.connect(socket);
  await world.dispatch(socket, ownerMessage("101", { author: { id: "11" } }));
  await world.dispatch(socket, ownerMessage("102", { author: { id: "10", bot: true } }));
  await world.dispatch(socket, ownerMessage("103", { author: { id: "99", bot: true } }));
  await world.dispatch(socket, ownerMessage("104", { webhook_id: "30" }));
  await world.dispatch(socket, ownerMessage("105", { type: 7 }));
  await world.dispatch(socket, ownerMessage("106", { channel_id: "21" }));
  expect(world.received).toEqual([]);
  expect(world.cursor("20")).toBe("105");
  await world.dispatch(socket, ownerMessage("107", { type: 19, message_reference: { message_id: "101" } }));
  expect(world.received).toEqual(["20:107"]);
});

test("READY backfills what was posted before the connection and a later live copy is not repeated", async () => {
  const world = await liveWorld([ownerMessage("100")], options);
  world.rest.state.messages.push(ownerMessage("101"), ownerMessage("102"));
  const [socket] = world.sockets;
  if (!socket) throw new Error("gateway did not open");
  await world.connect(socket);
  expect(world.received).toEqual(["20:101", "20:102"]);
  await world.dispatch(socket, ownerMessage("102")); // The same message arriving over both paths.
  await world.dispatch(socket, ownerMessage("101"));
  expect(world.received).toEqual(["20:101", "20:102"]);
  expect(world.cursor("20")).toBe("102");
});

test("a message sent during an outage is backfilled once after RESUMED, even when the gateway replays it", async () => {
  const world = await liveWorld([ownerMessage("100")], options);
  const [first] = world.sockets;
  if (!first) throw new Error("gateway did not open");
  await world.connect(first);
  await world.dispatch(first, ownerMessage("101"));
  first.disconnect(1006);
  world.rest.state.messages.push(ownerMessage("102"), ownerMessage("103"));
  world.advance(10_000);
  const second = world.sockets[1];
  if (!second) throw new Error("gateway did not reconnect");
  await world.connect(second, true);
  expect(second.frames[0]?.op).toBe(6);
  expect(world.received).toEqual(["20:101", "20:102", "20:103"]);
  await world.dispatch(second, ownerMessage("103")); // Replayed by the resumed session.
  await world.dispatch(second, ownerMessage("104"));
  expect(world.received).toEqual(["20:101", "20:102", "20:103", "20:104"]);
  expect(world.logs.some((line) => line.startsWith("DISCORD_GATEWAY_RECONNECT discord reason=closed code=1006"))).toBe(
    true,
  );
});

test("a terminal close code ends intake with an actionable error and does not retry", async () => {
  const world = await liveWorld([], options, { "20": "100" });
  const [socket] = world.sockets;
  if (!socket) throw new Error("gateway did not open");
  const outcome = world.live.done.then(
    () => "resolved",
    (error: unknown) => error,
  );
  socket.hello();
  socket.disconnect(4014);
  const error = await outcome;
  expect(error).toBeInstanceOf(MessengerError);
  expect((error as MessengerError).status).toBe(4014);
  world.advance(600_000);
  expect(world.sockets).toHaveLength(1);
});

test("a failing emitter stops intake: nothing queued behind it is delivered and its cursor is not advanced", async () => {
  let calls = 0;
  const world = await liveWorld([], options, { "20": "100" }, () => {
    if (++calls === 1) throw new Error("delivery failed");
  });
  const [socket] = world.sockets;
  if (!socket) throw new Error("gateway did not open");
  const outcome = world.live.done.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  await world.connect(socket);
  socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 5, d: ownerMessage("101") });
  socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 6, d: ownerMessage("102") }); // Already queued behind the failure.
  expect(await outcome).toBe("delivery failed");
  await settle();
  expect(world.received).toEqual([]);
  expect(world.cursor("20")).toBe("100");
  expect(socket.closed).toBe(true);
});

for (const failure of [429, 500, 502, 503, 504, "network"] as const) {
  test(`transient ${failure} backfill holds live messages and reconciles once when healthy`, async () => {
    const world = await liveWorld([ownerMessage("100")], options);
    const [socket] = world.sockets;
    if (!socket) throw new Error("gateway did not open");
    try {
      world.rest.state.messages.push(ownerMessage("101"), ownerMessage("102"));
      const path = "/channels/20/messages";
      if (failure === "network") world.rest.state.unreachable.add(path);
      else world.rest.state.failure.set(path, failure);
      await world.connect(socket);
      await world.dispatch(socket, ownerMessage("103"));
      expect(world.received).toEqual([]);
      expect(world.cursor("20")).toBe("100");
      expect(socket.closed).toBe(false);
      const requests = world.rest.requests.length;
      world.rest.state.failure.clear();
      world.rest.state.unreachable.clear();
      world.advance(2_000);
      await settle();
      expect(world.rest.requests).toHaveLength(requests + 1);
      expect(world.received).toEqual(["20:101", "20:102", "20:103"]);
      expect(world.cursor("20")).toBe("103");
      await world.dispatch(socket, ownerMessage("102"));
      await world.dispatch(socket, ownerMessage("103"));
      expect(world.received).toEqual(["20:101", "20:102", "20:103"]);
      expect(world.logs.filter((line) => line.startsWith("DISCORD_GATEWAY_BACKFILL_RETRY "))).toHaveLength(1);
    } finally {
      world.live.close();
    }
  });
}

for (const fault of ["json", "page", "message", "oversized", "pagination", "channel"] as const) {
  test(`local ${fault} fault stops the actual backfill queue without delivery or cursor advancement`, async () => {
    const world = await liveWorld([], { ...options, all: fault === "channel" }, { "20": "100" });
    const [socket] = world.sockets;
    if (!socket) throw new Error("gateway did not open");
    let failure: unknown;
    void world.live.done.catch((error: unknown) => {
      failure = error;
    });
    try {
      const path = "/channels/20/messages";
      if (fault === "json") world.rest.state.responses.set(path, "{");
      if (fault === "page") world.rest.state.responses.set(path, "{}");
      if (fault === "message") world.rest.state.responses.set(path, '[{"id":"bad"}]');
      if (fault === "oversized")
        world.rest.state.responses.set(path, JSON.stringify(Array.from({ length: 101 }, () => ownerMessage("101"))));
      if (fault === "pagination") {
        world.rest.state.messages.push(...Array.from({ length: 150 }, (_, i) => ownerMessage(String(i + 101))));
        world.rest.state.stuckBefore = true;
      }
      if (fault === "channel") {
        world.rest.state.guilds = [{ id: "5", channels: ["21"], threads: [] }];
        world.rest.state.responses.set("/channels/21/messages", JSON.stringify([ownerMessage("101")]));
      }
      socket.hello();
      socket.ready(1);
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("300") });
      await settle();
      expect(failure).toBeInstanceOf(MessengerError);
      expect((failure as MessengerError).status).toBe(502);
      expect(world.received).toEqual([]);
      expect(world.cursor("20")).toBe("100");
      if (fault === "channel") expect(world.cursor("21")).toBeUndefined();
      expect(socket.closed).toBe(true);
      const requests = world.rest.requests.length;
      world.advance(600_000);
      await settle();
      expect(world.rest.requests).toHaveLength(requests);
      expect(world.sockets).toHaveLength(1);
      expect(world.logs.filter((line) => line.startsWith("DISCORD_GATEWAY_BACKFILL_RETRY "))).toEqual([]);
    } finally {
      world.live.close();
    }
  });
}

for (const status of [400, 405]) {
  test(`remote HTTP ${status} stops backfill instead of being retried as a network failure`, async () => {
    const world = await liveWorld([ownerMessage("100")], options);
    const [socket] = world.sockets;
    if (!socket) throw new Error("gateway did not open");
    let failure: unknown;
    void world.live.done.catch((error: unknown) => {
      failure = error;
    });
    try {
      world.rest.state.failure.set("/channels/20/messages", status);
      socket.hello();
      socket.ready(1);
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("101") });
      await settle();
      expect(failure).toBeInstanceOf(MessengerError);
      expect((failure as MessengerError).status).toBe(status);
      expect(world.received).toEqual([]);
      expect(world.cursor("20")).toBe("100");
      expect(socket.closed).toBe(true);
      expect(world.pending.size).toBe(0);
      expect(world.logs.filter((line) => line.startsWith("DISCORD_GATEWAY_BACKFILL_RETRY "))).toEqual([]);
    } finally {
      world.live.close();
    }
  });
}
