import { expect, test } from "bun:test";
import { MessengerError } from "../src/messenger/http.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { liveWorld, settle } from "./discord-inbound-live-fakes.ts";

const options = { ownerId: "10", channelIds: ["20"] };

for (const ending of ["stop", "terminal"] as const) {
  test(`${ending} drains an active REST backfill before done and drops queued dispatches`, async () => {
    const world = await liveWorld([ownerMessage("100")], options);
    const [socket] = world.sockets;
    if (!socket) throw new Error("gateway did not open");
    const response = Promise.withResolvers<void>();
    let finished = false;
    const outcome = world.live.done.then(
      () => {
        finished = true;
        return undefined;
      },
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    try {
      world.rest.state.messages.push(ownerMessage("101"), ownerMessage("102"));
      world.rest.state.blocked.set("/channels/20/messages", response.promise);
      await world.connect(socket);
      await world.dispatch(socket, ownerMessage("103"));
      expect(world.received).toEqual([]);
      if (ending === "stop") world.live.close();
      else socket.disconnect(4014);
      await settle();
      expect(finished).toBe(false);
      expect(socket.closed).toBe(true);
      expect(world.pending.size).toBe(0);
      response.resolve();
      const error = await outcome;
      if (ending === "stop") expect(error).toBeUndefined();
      else {
        expect(error).toBeInstanceOf(MessengerError);
        expect((error as MessengerError).status).toBe(4014);
      }
      expect(world.received).toEqual(["20:101", "20:102"]);
      expect(world.cursor("20")).toBe("102");
      const requests = world.rest.requests.length;
      world.advance(600_000);
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 9, d: ownerMessage("104") });
      await settle();
      expect(world.received).toEqual(["20:101", "20:102"]);
      expect(world.cursor("20")).toBe("102");
      expect(world.rest.requests).toHaveLength(requests);
      expect(world.sockets).toHaveLength(1);
      expect(world.pending.size).toBe(0);
    } finally {
      response.resolve();
      world.live.close();
    }
  });
}

test("stop releases a pending backfill retry and retires all owned timers", async () => {
  const world = await liveWorld([ownerMessage("100")], options);
  const [socket] = world.sockets;
  if (!socket) throw new Error("gateway did not open");
  try {
    world.rest.state.failure.set("/channels/20/messages", 502);
    await world.connect(socket);
    await world.dispatch(socket, ownerMessage("101"));
    expect(world.pending.size).toBeGreaterThan(0);
    const requests = world.rest.requests.length;
    world.live.close();
    await world.live.done;
    expect(world.pending.size).toBe(0);
    expect(socket.closed).toBe(true);
    world.advance(600_000);
    await settle();
    expect(world.received).toEqual([]);
    expect(world.cursor("20")).toBe("100");
    expect(world.rest.requests).toHaveLength(requests);
    expect(world.sockets).toHaveLength(1);
  } finally {
    world.live.close();
  }
});

test("an active backfill failure after stop still rejects done without committing or emitting", async () => {
  const world = await liveWorld([ownerMessage("100")], options);
  const [socket] = world.sockets;
  if (!socket) throw new Error("gateway did not open");
  const response = Promise.withResolvers<void>();
  const path = "/channels/20/messages";
  try {
    world.rest.state.blocked.set(path, response.promise);
    await world.connect(socket);
    await world.dispatch(socket, ownerMessage("101"));
    world.live.close();
    world.rest.state.unreachable.add(path);
    response.resolve();
    await expect(world.live.done).rejects.toThrow(MessengerError);
    expect(world.received).toEqual([]);
    expect(world.cursor("20")).toBe("100");
    expect(socket.closed).toBe(true);
    expect(world.pending.size).toBe(0);
  } finally {
    response.resolve();
    world.live.close();
  }
});
