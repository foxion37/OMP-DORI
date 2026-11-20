import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MessengerError } from "../src/messenger/http.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { liveWorld, memoryLiveWorld, settle } from "./discord-inbound-live-fakes.ts";

// These scenarios verify admission to the private POSIX disk queue.
const diskTest = test.skipIf(process.platform === "win32");
const options = { ownerId: "10", channelIds: ["20"] };

diskTest(
  "unknown 429 retains its original frame while known scope is durably admitted without an unscoped spool",
  async () => {
    const emit = Promise.withResolvers<void>();
    const world = await liveWorld([ownerMessage("100")], options, {}, () => emit.promise);
    const socket = world.sockets[0]!;
    try {
      await world.connect(socket);
      world.rest.state.threadParents.set("50", "20");
      world.rest.state.failure.set("/channels/50", 429);
      const candidate = ownerMessage("201", { channel_id: "50", content: "unresolved-private-frame" });
      world.rest.state.messages.push(candidate);
      await world.dispatch(socket, candidate);
      world.rest.state.messages.splice(world.rest.state.messages.indexOf(candidate), 1); // Deleted during retry.
      await world.dispatch(socket, ownerMessage("101"));
      expect(world.logs).toContain("DISCORD_GATEWAY_ACCEPT_RETRY discord retry_in=2s");
      expect(JSON.parse(world.queue.first()!.payload).id).toBe("101");
      expect(world.queue.nextChannel("20")).toBeUndefined();
      const directory = join(world.dir, "discord-inbound");
      for (const file of readdirSync(directory).filter((name) => name.startsWith("gateway.sqlite"))) {
        expect(readFileSync(join(directory, file)).includes(Buffer.from("unresolved-private-frame"))).toBe(false);
      }
      world.rest.state.failure.clear();
      world.advance(2_000);
      await settle();
      const retained = world.queue.nextOwner("50", "10", "201", "0", 0);
      expect(retained?.parent).toBe("20");
      expect(retained?.admittedAfter).toBe("100");
      expect(JSON.parse(retained!.payload).content).toBe("unresolved-private-frame");
      expect(world.rest.state.messages.some((message) => message.id === "201")).toBe(false);
      emit.resolve();
      await settle();
      expect(world.received).toEqual(["20:101", "50:201"]);
      expect(world.cursor("50")).toBe("201");
      expect(world.queue.first()).toBeNull();
    } finally {
      emit.resolve();
    }
  },
);

diskTest(
  "100 unresolved frames share one resolver; frame 101 fails visibly and preserves committed known work",
  async () => {
    const lookup = Promise.withResolvers<void>();
    const emit = Promise.withResolvers<void>();
    const world = await liveWorld([ownerMessage("100")], options, {}, () => emit.promise);
    const outcome = world.live.done.catch((error: unknown) => error);
    const socket = world.sockets[0]!;
    try {
      await world.connect(socket);
      world.rest.state.blocked.set("/channels/50", lookup.promise);
      for (let index = 0; index < 100; index++) {
        await world.dispatch(
          socket,
          ownerMessage(String(200 + index), {
            channel_id: index % 2 === 0 ? "50" : "51",
            content: "secret-candidate",
          }),
        );
      }
      expect(socket.closed).toBe(false);
      expect(
        world.rest.requests.filter((request) => new URL(request.url).pathname.endsWith("/channels/50")),
      ).toHaveLength(1);
      expect(world.rest.requests.some((request) => new URL(request.url).pathname.endsWith("/channels/51"))).toBe(false);
      await world.dispatch(socket, ownerMessage("101"));
      const committed = world.queue.first();
      expect(JSON.parse(committed!.payload).id).toBe("101");
      await world.dispatch(socket, ownerMessage("300", { channel_id: "52", content: "secret-overflow" }));
      emit.resolve();
      const error = await outcome;
      expect(error).toBeInstanceOf(MessengerError);
      expect((error as Error).message).toContain("limits=100 frames/1048576 bytes");
      expect((error as Error).message).toContain("pending=101 frames");
      expect((error as Error).message).not.toContain("secret");
      expect(world.rest.state.aborted).toEqual(["/channels/50"]);
      expect(world.queue.first()).toEqual(committed);
      expect(world.queue.nextChannel("20")).toBeUndefined();
    } finally {
      lookup.resolve();
      emit.resolve();
    }
  },
);

for (const oversized of [false, true]) {
  test(`${oversized ? "one oversized candidate" : "exactly 1 MiB then one more candidate"} enforces serialized bytes`, async () => {
    const lookup = Promise.withResolvers<void>();
    const world = await memoryLiveWorld([ownerMessage("100")], options);
    const outcome = world.live.done.catch((error: unknown) => error);
    const socket = world.sockets[0]!;
    try {
      await world.connect(socket);
      world.rest.state.blocked.set("/channels/50", lookup.promise);
      const empty = ownerMessage("201", { channel_id: "50", content: "" });
      const overhead = Buffer.byteLength(JSON.stringify(empty));
      const content = "x".repeat(1024 * 1024 - overhead + Number(oversized));
      await world.dispatch(socket, { ...empty, content });
      if (!oversized) {
        expect(socket.closed).toBe(false);
        await world.dispatch(socket, ownerMessage("202", { channel_id: "50" }));
      }
      const error = await outcome;
      expect(error).toBeInstanceOf(MessengerError);
      expect((error as Error).message).toContain("1048576 bytes");
      expect((error as Error).message).not.toContain("xxxx");
      expect(world.queue.first()).toBeNull();
      expect(world.cursor("50")).toBeUndefined();
    } finally {
      lookup.resolve();
    }
  });
}

test("an unknown unwatched parent is cached without admitting its payload or reading history", async () => {
  const world = await memoryLiveWorld([ownerMessage("100")], options);
  const socket = world.sockets[0]!;
  await world.connect(socket);
  world.rest.state.threadParents.set("51", "21");
  await world.dispatch(socket, ownerMessage("301", { channel_id: "51" }));
  await world.dispatch(socket, ownerMessage("302", { channel_id: "51" }));
  expect(world.received).toEqual([]);
  expect(world.queue.first()).toBeNull();
  expect(world.rest.requests.filter((request) => new URL(request.url).pathname.endsWith("/channels/51"))).toHaveLength(
    1,
  );
  expect(world.rest.requests.some((request) => request.url.includes("/channels/51/messages"))).toBe(false);
});

for (const failure of [500, "network"] as const) {
  test(`unknown metadata ${failure} retries its retained original payload using the existing backoff`, async () => {
    const world = await memoryLiveWorld([ownerMessage("100")], options);
    const socket = world.sockets[0]!;
    await world.connect(socket);
    world.rest.state.threadParents.set("50", "20");
    if (failure === "network") world.rest.state.unreachable.add("/channels/50");
    else world.rest.state.failure.set("/channels/50", failure);
    await world.dispatch(socket, ownerMessage("201", { channel_id: "50" }));
    expect(world.received).toEqual([]);
    expect(world.logs).toContain("DISCORD_GATEWAY_ACCEPT_RETRY discord retry_in=2s");
    world.rest.state.failure.clear();
    world.rest.state.unreachable.clear();
    world.advance(2_000);
    await settle();
    expect(world.received).toEqual(["50:201"]);
    expect(world.cursor("50")).toBe("201");
  });
}
