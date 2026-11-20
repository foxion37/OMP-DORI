import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { Discord } from "../src/messenger/discord.ts";
import { inboundRequest } from "../src/messenger/discord-inbound-api.ts";
import { discordThreadAdmission } from "../src/messenger/discord-inbound-thread-admission.ts";
import { fetchHttp, withBackoff } from "../src/messenger/http.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { memoryLiveWorld, settle } from "./discord-inbound-live-fakes.ts";
import { gatewayTimers } from "./discord-presence-fakes.ts";
import { fakeClock } from "./fakes.ts";

test("owned metadata cancellation aborts an actual loopback fetch and closes its unfinished response", async () => {
  const entered = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  let requests = 0;
  let unfinished = false;
  const server = createServer((_request, response) => {
    requests++;
    response.once("close", () => {
      unfinished = !response.writableEnded;
      disconnected.resolve();
    });
    entered.resolve(); // Deliberately do not produce a response body.
  });
  const controller = new AbortController();
  const reason = new Error("owned metadata stop");
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback server has no TCP address");
    const request = inboundRequest(new Discord(fetchHttp, fakeClock(0), "offline", `http://127.0.0.1:${address.port}`));
    const outcome = request("/channels/50", undefined, controller.signal).catch((error: unknown) => error);
    await entered.promise;
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    await disconnected.promise;
    expect(requests).toBe(1);
    expect(unfinished).toBe(true);
  } finally {
    controller.abort(reason);
    const closed = once(server, "close");
    server.closeAllConnections();
    server.close();
    await closed;
  }
});

test("optional HTTP backoff cancellation clears its owned wait without changing nonsignaled clock behavior", async () => {
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error("owned backoff stop");
  let attempts = 0;
  const outcome = withBackoff(
    async () => {
      attempts++;
      entered.resolve();
      return { status: 429, headers: { "retry-after": "60" }, body: "{}" };
    },
    {
      now: () => 0,
      sleep: async () => {
        throw new Error("uncancellable clock sleep used");
      },
    },
    {
      method: "GET",
      url: "http://127.0.0.1/unused",
      signal: controller.signal,
    },
  ).catch((error: unknown) => error);
  await entered.promise;
  controller.abort(reason);
  expect(await outcome).toBe(reason);
  expect(attempts).toBe(1);
  const waits: number[] = [];
  const clock = {
    now: () => 0,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
  let ordinary = 0;
  const response = await withBackoff(
    async () => ({
      status: ++ordinary === 1 ? 429 : 200,
      headers: {},
      body: "{}",
    }),
    clock,
    { method: "GET", url: "http://127.0.0.1/unused" },
  );
  expect(response.status).toBe(200);
  expect(waits).toEqual([1000]);
});

test("close cancels a thread retry timer without adopting, enqueuing or waking after retry completion", async () => {
  const world = await memoryLiveWorld([ownerMessage("100")], { ownerId: "10", channelIds: ["20"] });
  const socket = world.sockets[0]!;
  await world.connect(socket);
  world.rest.state.threadParents.set("50", "20");
  world.rest.state.failure.set("/channels/50", 429);
  await world.dispatch(socket, ownerMessage("201", { channel_id: "50" }));
  expect(world.logs).toContain("DISCORD_GATEWAY_ACCEPT_RETRY discord retry_in=2s");
  const requests = world.rest.requests.length;
  world.live.close();
  await world.live.done;
  world.rest.state.failure.clear();
  world.advance(30_000);
  await settle();
  expect(world.rest.requests).toHaveLength(requests);
  expect(world.intake.channels()).toEqual(["20"]);
  expect(world.cursor("50")).toBeUndefined();
  expect(world.queue.first()).toBeNull();
  expect(world.pending.size).toBe(0);
});

test.each([8, 3_600])(
  "live metadata keeps the server's %is rate-limit floor or stops at the budget",
  async (seconds) => {
    const world = await memoryLiveWorld([ownerMessage("100")], { ownerId: "10", channelIds: ["20"] });
    const [socket] = world.sockets;
    if (!socket) throw new Error("gateway did not open");
    await world.connect(socket);
    const path = "/channels/50";
    world.rest.state.threadParents.set("50", "20");
    world.rest.state.failure.set(path, 429);
    world.rest.state.retryAfter.set(path, String(seconds));
    await world.dispatch(socket, ownerMessage("201", { channel_id: "50" }));
    const requests = world.rest.requests.length;
    world.rest.state.failure.delete(path);

    if (seconds === 3_600) {
      expect(socket.closed).toBe(true);
      await expect(world.live.done).rejects.toMatchObject({ status: 429, code: "RATE_LIMIT_WAIT_EXCEEDED" });
      world.advance(60_000);
      await settle();
      expect(world.rest.requests).toHaveLength(requests);
      expect(world.received).toEqual([]);
    } else {
      world.advance(2_000);
      await settle();
      expect(world.rest.requests).toHaveLength(requests);
      expect(world.received).toEqual([]);
      world.advance(6_000);
      await settle();
      expect(world.received).toEqual(["50:201"]);
      expect(world.cursor("50")).toBe("201");
    }
  },
);

for (const fault of [new Error("real resolver fault"), new DOMException("unrelated abort", "AbortError")]) {
  test(`close preserves a non-owned resolver failure: ${fault.message}`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failures: unknown[] = [];
    let adopted = 0;
    let admitted = 0;
    const metadata = discordThreadAdmission(
      {
        cursorFor: () => "100",
        needsThread: () => true,
        resolveThread: async () => {
          entered.resolve();
          await release.promise;
          throw fault;
        },
        adoptThread: () => {
          adopted++;
          return "100";
        },
      },
      gatewayTimers().clock,
      () => {
        admitted++;
      },
      () => {},
      (error) => failures.push(error),
    );
    metadata.push(ownerMessage("201", { channel_id: "50" }));
    await entered.promise;
    metadata.close();
    release.resolve();
    await metadata.done();
    expect(failures).toEqual([fault]);
    expect(adopted).toBe(0);
    expect(admitted).toBe(0);
  });
}

test("request normalization does not convert an unrelated AbortError into a transient network retry", async () => {
  const fault = new DOMException("unrelated transport abort", "AbortError");
  const request = inboundRequest(
    new Discord(
      async () => {
        throw fault;
      },
      fakeClock(0),
      "offline",
    ),
  );
  expect(await request("/channels/50", undefined, new AbortController().signal).catch((error: unknown) => error)).toBe(
    fault,
  );
});

for (const protocol of [false, true]) {
  test(`unknown metadata ${protocol ? "protocol error" : "HTTP 401"} stops rather than retrying past a fault`, async () => {
    const world = await memoryLiveWorld([ownerMessage("100")], { ownerId: "10", channelIds: ["20"] });
    const socket = world.sockets[0]!;
    const outcome = world.live.done.catch((error: unknown) => error);
    await world.connect(socket);
    if (protocol) world.rest.state.responses.set("/channels/50", "[null]");
    else world.rest.state.failure.set("/channels/50", 401);
    await world.dispatch(socket, ownerMessage("201", { channel_id: "50" }));
    expect(await outcome).toMatchObject(
      protocol ? { status: 502, code: "DISCORD_INBOUND_PROTOCOL_ERROR" } : { status: 401 },
    );
    expect(world.logs.some((line) => line.startsWith("DISCORD_GATEWAY_ACCEPT_RETRY"))).toBe(false);
    expect(world.queue.first()).toBeNull();
    expect(world.cursor("50")).toBeUndefined();
  });
}
