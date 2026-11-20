import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import { discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { discordRestWorld, ownerMessage } from "./discord-inbound-fakes.ts";
import { settle } from "./discord-inbound-live-fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { withState } from "./fakes.ts";

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

posix(
  "a stalled backfill retains dispatches on disk, not a growing Promise chain",
  async () => {
    const state = withState();
    const queue = discordInboundQueue(state.dir);
    const hold = Promise.withResolvers<void>();
    const socket = new FakeGateway("offline");
    const accepted: number[] = [];
    const live = discordInboundLive(
      {
        accepts: () => true,
        cursorFor: () => undefined,
        sync: () => hold.promise,
        accept: (message) => {
          accepted.push(Number(message.id));
        },
      },
      () => socket,
      "offline",
      gatewayTimers().clock,
      () => {},
      () => {},
      queue,
    );
    try {
      socket.hello();
      socket.ready(1);
      await settle();
      Bun.gc(true);
      const before = process.memoryUsage().heapUsed;
      for (let id = 1; id <= 3_000; id++) {
        socket.receive({
          op: 0,
          t: "MESSAGE_CREATE",
          s: id + 1,
          d: ownerMessage(String(id), { content: "x".repeat(2_000) + id }),
        });
      }
      Bun.gc(true);
      expect(process.memoryUsage().heapUsed - before).toBeLessThan(4 * 1024 * 1024);
      expect(accepted).toEqual([]);
      const path = join(state.dir, "discord-inbound/gateway.sqlite");
      const snapshot = join(state.dir, "snapshot.sqlite");
      // Intake is blocked and no writer can run during these synchronous copies.
      copyFileSync(path, snapshot);
      copyFileSync(`${path}-wal`, `${snapshot}-wal`);
      const db = new Database(snapshot, { readonly: true });
      try {
        expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM pending").get()?.n).toBe(3_001);
      } finally {
        db.close();
      }
      hold.resolve();
      await settle();
      expect(accepted).toEqual(Array.from({ length: 3_000 }, (_, i) => i + 1));
      expect(queue.first()).toBeNull();
    } finally {
      hold.resolve();
      live.close();
      await live.done;
      queue.close();
      state.done();
    }
  },
  30_000,
);

posix("shutdown retains queued work, and restart emits it once before later READY work", async () => {
  const state = withState();
  let queue = discordInboundQueue(state.dir);
  const rest = discordRestWorld([ownerMessage("100")]);
  let intake = await discordInbound(rest.discord, queue.storeFor, { ownerId: "10", channelIds: ["20"] });
  const hold = Promise.withResolvers<void>();
  rest.state.blocked.set("/channels/20/messages", hold.promise);
  let socket = new FakeGateway("offline");
  const received: string[] = [];
  let live = discordInboundLive(
    intake,
    () => socket,
    "offline",
    gatewayTimers().clock,
    (m) => received.push(m.message),
    () => {},
    queue,
  );
  try {
    socket.hello();
    socket.ready(1);
    await settle();
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("101") });
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: ownerMessage("102") });
    live.close();
    hold.resolve();
    await live.done;
    expect(received).toEqual([]);
    expect(queue.first()?.kind).toBe("sync");
    queue.close();
    queue = discordInboundQueue(state.dir);
    intake = await discordInbound(rest.discord, queue.storeFor, { ownerId: "10", channelIds: ["20"] });
    socket = new FakeGateway("offline");
    live = discordInboundLive(
      intake,
      () => socket,
      "offline",
      gatewayTimers().clock,
      (m) => received.push(m.message),
      () => {},
      queue,
    );
    socket.hello();
    socket.ready(1);
    await settle();
    expect(received).toEqual(["101", "102"]);
    expect(queue.storeFor("20").load()).toBe("102");
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("102") });
    await settle();
    expect(received).toEqual(["101", "102"]);
    expect(queue.first()).toBeNull();
  } finally {
    hold.resolve();
    live.close();
    await live.done;
    queue.close();
    state.done();
  }
});

posix("queued messages in a newly discovered channel are not cold-baselined away on restart", async () => {
  const state = withState();
  let queue = discordInboundQueue(state.dir);
  try {
    queue.push("message", ownerMessage("101", { channel_id: "21" }));
    queue.close();
    queue = discordInboundQueue(state.dir);
    const rest = discordRestWorld([ownerMessage("102", { channel_id: "21" })]);
    rest.state.guilds = [{ id: "5", channels: ["21"], threads: [] }];
    const intake = await discordInbound(rest.discord, queue.storeFor, { ownerId: "10", channelIds: [], all: true });
    expect(queue.storeFor("21").load()).toBe("100");
    const socket = new FakeGateway("offline");
    const received: string[] = [];
    const live = discordInboundLive(
      intake,
      () => socket,
      "offline",
      gatewayTimers().clock,
      (m) => received.push(m.message),
      () => {},
      queue,
    );
    try {
      socket.hello();
      socket.ready(1);
      await settle();
      expect(received).toEqual(["101", "102"]);
    } finally {
      live.close();
      await live.done;
    }
  } finally {
    queue.close();
    state.done();
  }
});

posix("an emitter failure retains its record and successors without skipping the cursor", async () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  try {
    queue.push("message", ownerMessage("101"));
    queue.push("message", ownerMessage("102"));
    const intake = await discordInbound(discordRestWorld([]).discord, queue.storeFor, {
      ownerId: "10",
      channelIds: ["20"],
    });
    const socket = new FakeGateway("offline");
    const live = discordInboundLive(
      intake,
      () => socket,
      "offline",
      gatewayTimers().clock,
      () => {
        throw new Error("emit failed");
      },
      () => {},
      queue,
    );
    await expect(live.done).rejects.toThrow("emit failed");
    expect(JSON.parse(queue.first()?.payload ?? "null").id).toBe("101");
    expect(queue.storeFor("20").load()).toBe("100");
    expect(socket.closed).toBe(true);
  } finally {
    queue.close();
    state.done();
  }
});

posix("queue files and sidecars remain private and unsafe paths are rejected", () => {
  const state = withState();
  const path = join(state.dir, "discord-inbound/gateway.sqlite");
  try {
    const queue = discordInboundQueue(state.dir);
    queue.push("message", ownerMessage("101"));
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    queue.close();
    symlinkSync(path, `${path}-journal`);
    expect(() => discordInboundQueue(state.dir)).toThrow("private regular file");
    chmodSync(path, 0o640);
    expect(() => discordInboundQueue(state.dir)).toThrow("private regular file");
  } finally {
    state.done();
  }
});
