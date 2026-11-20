import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import { type DiscordInboundLive, discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { type DiscordInboundQueue, discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { discordRestWorld, ownerMessage } from "./discord-inbound-fakes.ts";
import { queuedWorld, settle } from "./discord-inbound-live-fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { withState } from "./fakes.ts";

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

for (const during of [false, true])
  posix(`105 admitted ${during ? "during 107 emit arrives late" : "before 107 selection merges first"}`, async () => {
    const world = await queuedWorld({
      history: during ? [ownerMessage("107")] : [ownerMessage("103"), ownerMessage("107")],
      messages: [ownerMessage("109")],
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const run = await world.start(async (message) => {
        if (message.message === (during ? "107" : "103")) {
          entered.resolve();
          await release.promise;
        }
      });
      await entered.promise;
      run.socket.hello();
      run.socket.ready(1);
      run.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("105") });
      if (during) run.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: ownerMessage("107") });
      expect(world.cursor()).toBe("102");
      expect(world.received).toEqual([]);
      expect(world.queue().nextOwner("20", "10", "105", "0", 0)?.admittedAfter).toBe("102");
      release.resolve();
      await settle();
      expect(world.received).toEqual(
        during ? ["20:107", "20:105", "20:109"] : ["20:103", "20:105", "20:107", "20:109"],
      );
      expect(world.saves).toEqual(during ? ["20:107", "20:107", "20:109"] : ["20:103", "20:105", "20:107", "20:109"]);
      expect(world.cursor()).toBe("109");
      expect(world.queue().first()).toBeNull();
      const saves = world.saves.slice();
      run.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("105") });
      await run.intake.accept(ownerMessage("105"), () => {
        throw new Error("direct stale accept emitted");
      });
      await settle();
      expect(world.saves).toEqual(saves);
      expect(world.received.filter((id) => id === "20:105")).toHaveLength(1);
      expect(world.queue().first()).toBeNull();
    } finally {
      release.resolve();
    }
  });

for (const admission of ["102", "107", "legacy"] as const)
  posix(
    `${admission} admission behind cursor 107 distinguishes an undelivered older owner from a stale replay`,
    async () => {
      const world = await queuedWorld({
        messages: [ownerMessage("105"), ownerMessage("109")],
        cursors: { "20": "107" },
        admissions: admission === "legacy" ? {} : { "105": admission },
        legacy: admission === "legacy",
      });
      await world.start();
      await settle();
      expect(world.received).toEqual(admission === "107" ? ["20:109"] : ["20:105", "20:109"]);
      expect(world.cursor()).toBe("109");
      expect(world.queue().first()).toBeNull();
    },
  );

for (const legacy of [false, true])
  posix(
    `cursor equality retains its existing gate despite ${legacy ? "unknown legacy" : "older"} admission`,
    async () => {
      const world = await queuedWorld({
        messages: [ownerMessage("105"), ownerMessage("109")],
        cursors: { "20": "105" },
        admissions: { "105": "102" },
        legacy,
      });
      await world.start();
      await settle();
      expect(world.received).toEqual(["20:109"]);
      expect(world.saves).toEqual(["20:109"]);
      expect(world.cursor()).toBe("109");
      expect(world.queue().first()).toBeNull();
    },
  );

posix("reading a new channel's admission cursor does not seed it ahead of a later older queued frame", async () => {
  const world = await queuedWorld({
    history: [ownerMessage("207"), ownerMessage("107", { channel_id: "50" })],
    messages: [],
    cursors: { "20": "202" },
    options: { ownerId: "10", channelIds: ["20"], all: true },
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const run = await world.start(async (message) => {
      if (message.message === "207") {
        entered.resolve();
        await release.promise;
      }
    });
    await entered.promise;
    run.socket.hello();
    run.socket.ready(1);
    run.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("109", { channel_id: "50" }) });
    expect(run.intake.cursorFor("50")).toBeUndefined();
    expect(world.queue().nextOwner("50", "10", "109", "0", 0)?.admittedAfter).toBeNull();
    run.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: ownerMessage("105", { channel_id: "50" }) });
    expect(run.intake.cursorFor("50")).toBeUndefined();
    expect(world.queue().nextOwner("50", "10", "105", "0", 0)?.admittedAfter).toBeNull();
    release.resolve();
    await settle();
    expect(world.received).toEqual(["20:207", "50:105", "50:107", "50:109"]);
    expect(world.cursor("20")).toBe("207");
    expect(world.cursor("50")).toBe("109");
    expect(world.queue().first()).toBeNull();
  } finally {
    release.resolve();
  }
});

posix("the original three-column database migrates additively and replays ambiguous pending owners", async () => {
  const state = withState();
  let queue: DiscordInboundQueue | undefined;
  let live: DiscordInboundLive | undefined;
  try {
    fileDiscordInboundStore(state.dir, "20").save("107");
    const path = join(state.dir, "discord-inbound/gateway.sqlite");
    writeFileSync(path, "", { mode: 0o600 });
    const old = new Database(path);
    try {
      old.exec("CREATE TABLE pending (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)");
      const insert = old.query("INSERT INTO pending (kind, payload) VALUES (?, ?)");
      insert.run("sync", "null");
      insert.run("message", JSON.stringify(ownerMessage("105")));
      insert.run("message", JSON.stringify(ownerMessage("109")));
    } finally {
      old.close();
    }
    queue = discordInboundQueue(state.dir);
    const retained = queue.nextOwner("20", "10", "105", "0", 0);
    expect(retained?.admittedAfter).toBeNull();
    expect(JSON.parse(retained!.payload)).toEqual(ownerMessage("105"));
    expect(queue.first()?.kind).toBe("sync");
    queue.close();
    queue = undefined;
    const migrated = new Database(path, { readonly: true });
    try {
      expect(
        migrated
          .query<{ name: string }, []>("PRAGMA table_info(pending)")
          .all()
          .map((row) => row.name),
      ).toEqual(["id", "kind", "payload", "admitted_after", "thread_parent"]);
      expect(
        migrated
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
          .all()
          .map((row) => row.name),
      ).toEqual(["pending_channel", "pending_owner"]);
    } finally {
      migrated.close();
    }
    queue = discordInboundQueue(state.dir);
    expect(queue.nextOwner("20", "10", "105", "0", 0)?.admittedAfter).toBeNull();
    const intake = await discordInbound(discordRestWorld([ownerMessage("107")]).discord, queue.storeFor, {
      ownerId: "10",
      channelIds: ["20"],
    });
    const received: string[] = [];
    live = discordInboundLive(
      intake,
      () => new FakeGateway("offline"),
      "offline",
      gatewayTimers().clock,
      (message) => received.push(message.message),
      () => {},
      queue,
    );
    await settle();
    expect(received).toEqual(["105", "109"]);
    expect(fileDiscordInboundStore(state.dir, "20").load()).toBe("109");
    expect(queue.first()).toBeNull();
  } finally {
    live?.close();
    await live?.done;
    queue?.close();
    state.done();
  }
});
