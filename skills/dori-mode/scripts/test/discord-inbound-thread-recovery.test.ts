import { expect, test } from "bun:test";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import type { DiscordInbound } from "../src/messenger/discord-inbound-api.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { liveWorld, queuedWorld, settle } from "./discord-inbound-live-fakes.ts";

// Recovery uses the production queue and cursor stores, which require POSIX ownership and modes.
const diskTest = test.skipIf(process.platform === "win32");

for (const sync of [false, true]) {
  for (const status of [403, 404]) {
    diskTest(
      `admitted archived thread survives reopen with ${status} history/metadata and ${sync ? "sync" : "message"} prefix`,
      async () => {
        const attachment = { filename: "owner.txt", size: 3, url: "https://cdn.invalid/owner?signature=exact" };
        const world = await queuedWorld({
          history: [ownerMessage("100")],
          messages: [
            ownerMessage("105", {
              channel_id: "50",
              content: "deleted owner body",
              attachments: [attachment],
              message_reference: { message_id: "103" },
              referenced_message: { id: "103", author: { id: "10" }, content: "original reply context" },
            }),
          ],
          cursors: { "20": "100", "50": "102" },
          parents: { "50": "20" },
          sync,
        });
        world.rest.state.failure.set("/channels/50", status);
        world.rest.state.failure.set("/channels/50/messages", status);
        const received: DiscordInbound[] = [];
        const run = await world.start((message) => received.push(message));
        await settle();
        expect(world.received).toEqual(["50:105"]);
        expect(received[0]).toEqual({
          channel: "50",
          message: "105",
          reference: "103",
          text: "deleted owner body",
          replyTo: { id: "103", author: "10", text: "original reply context" },
          attachments: [attachment],
        });
        expect(world.cursor("50")).toBe("105");
        expect(run.intake.channels()).toEqual(["20"]); // Recovery is not reactivation of polling.
        expect(world.queue().first()).toBeNull();
        expect(world.rest.requests.some((request) => new URL(request.url).pathname.endsWith("/channels/50"))).toBe(
          false,
        );
        await world.restart();
        await settle();
        expect(world.received).toEqual(["50:105"]);
      },
    );
  }
}

for (const disabled of [false, true]) {
  diskTest(
    `parent provenance does not authorize siblings, nullable legacy rows or ${disabled ? "disabled" : "unwatched"} parents`,
    async () => {
      const world = await queuedWorld({
        history: [ownerMessage("100")],
        messages: [
          ownerMessage("105", { channel_id: "50" }),
          ownerMessage("205", { channel_id: "51" }),
          ownerMessage("305", { channel_id: "52" }),
        ],
        cursors: { "20": "100", "50": "102", "51": "202", "52": "302" },
        parents: { "50": "20", "51": "21" },
        options: { ownerId: "10", channelIds: ["20"], threads: !disabled },
      });
      const run = await world.start();
      await settle();
      expect(world.received).toEqual(disabled ? [] : ["50:105"]);
      expect(run.intake.channels()).toEqual(["20"]);
      expect(world.cursor("51")).toBe("202");
      expect(world.cursor("52")).toBe("302");
      expect(world.queue().first()).toBeNull();
      expect(world.rest.requests.some((request) => /\/channels\/(51|52)\/messages/.test(request.url))).toBe(false);
    },
  );
}

diskTest(
  "thread admission cursor 102 preserves late 105 behind 107 across restart without a backwards checkpoint",
  async () => {
    const world = await queuedWorld({
      history: [ownerMessage("100")],
      messages: [ownerMessage("105", { channel_id: "50" }), ownerMessage("109", { channel_id: "50" })],
      cursors: { "20": "100", "50": "107" },
      admissions: { "105": "102", "109": "107" },
      parents: { "50": "20" },
    });
    world.rest.state.denied.add("50");
    await world.start();
    await settle();
    expect(world.received).toEqual(["50:105", "50:109"]);
    expect(world.saves).toEqual(["50:107", "50:109"]);
    expect(world.cursor("50")).toBe("109");
    await world.restart();
    await settle();
    expect(world.received).toEqual(["50:105", "50:109"]);
  },
);

diskTest("closing before scope confirmation leaves no fake recoverable message in a new intake", async () => {
  const lookup = Promise.withResolvers<void>();
  const world = await liveWorld([ownerMessage("100")], { ownerId: "10", channelIds: ["20"] });
  const socket = world.sockets[0]!;
  try {
    await world.connect(socket);
    world.rest.state.threadParents.set("50", "20");
    world.rest.state.blocked.set("/channels/50", lookup.promise);
    await world.dispatch(socket, ownerMessage("201", { channel_id: "50" }));
    world.live.close();
    await world.live.done;
    expect(world.rest.state.aborted).toEqual(["/channels/50"]);
    lookup.resolve();
    await settle();
    expect(world.queue.first()).toBeNull();
    expect(world.cursor("50")).toBeUndefined();
    expect(world.intake.channels()).toEqual(["20"]);
    const recovered = await discordInbound(world.rest.discord, world.queue.storeFor, {
      ownerId: "10",
      channelIds: ["20"],
    });
    await recovered.sync((message) => world.received.push(`${message.channel}:${message.message}`), world.queue);
    expect(world.received).toEqual([]); // The unadmitted, remotely absent body was never on disk.
  } finally {
    lookup.resolve();
  }
});

for (const inRest of [false, true]) {
  diskTest(
    `listing scope promotes unresolved originals before backfill, with REST copy ${inRest ? "present" : "absent"}`,
    async () => {
      const lookup = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const world = await queuedWorld({
        history: [ownerMessage("100")],
        messages: [],
        cursors: { "20": "100" },
        sync: false,
      });
      world.rest.state.guilds = [{ id: "5", channels: ["20"], threads: [] }];
      world.rest.state.threadParents.set("50", "20");
      const run = await world.start(async (message) => {
        if (message.message === "107") {
          entered.resolve();
          await release.promise;
        }
      });
      try {
        run.socket.hello();
        run.socket.ready(1);
        await settle();
        world.rest.state.blocked.set("/channels/50", lookup.promise);
        run.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("105", { channel_id: "50" }) });
        await settle();
        expect(world.cursor("50")).toBeUndefined();
        world.rest.state.guilds[0]!.threads = ["50"];
        if (inRest) world.rest.state.messages.push(ownerMessage("105", { channel_id: "50" }));
        world.rest.state.messages.push(ownerMessage("107", { channel_id: "50" }));
        run.socket.receive({ op: 0, t: "RESUMED", s: 3, d: {} });
        await entered.promise;
        expect(world.received).toEqual(["50:105"]);
        expect(world.cursor("50")).toBe("105");
        expect(world.rest.state.aborted).toEqual(["/channels/50"]);
        release.resolve();
        await settle();
        expect(world.received).toEqual(["50:105", "50:107"]);
        expect(world.cursor("50")).toBe("107");
        expect(world.queue().first()).toBeNull();
        lookup.resolve();
        await settle();
        expect(world.received).toEqual(["50:105", "50:107"]);
        await world.restart();
        await settle();
        expect(world.received).toEqual(["50:105", "50:107"]);
      } finally {
        lookup.resolve();
        release.resolve();
      }
    },
  );
}

for (const sync of [false, true]) {
  for (const admittedAfter of [undefined, "102"]) {
    for (const excluded of ["105", "107", "109"]) {
      diskTest(
        `mixed archived ${sync ? "sync" : "message"} rows discard ${excluded}/${admittedAfter ?? "legacy"}`,
        async () => {
          const world = await queuedWorld({
            history: [ownerMessage("100"), ownerMessage("110", { channel_id: "50" })],
            messages: [],
            cursors: { "20": "100", "50": "102" },
            sync,
          });
          world.queue().push("message", ownerMessage(excluded, { channel_id: "50" }), admittedAfter);
          world.queue().push("message", ownerMessage("107", { channel_id: "50" }), "102", "20");
          const beforeEmit: (string | undefined)[] = [];
          const run = await world.restart(() => {
            beforeEmit.push(world.cursor("50"));
          });
          await settle();
          expect(world.received).toEqual(["50:107", "50:110"]);
          expect(beforeEmit).toEqual(["102", "107"]);
          expect(world.saves).toEqual(["50:107", "50:110"]);
          expect(run.intake.channels()).toEqual(["20"]);
          expect(world.queue().first()).toBeNull();
          await world.restart();
          await settle();
          expect(world.received).toEqual(["50:107", "50:110"]);
          expect(world.queue().first()).toBeNull();
        },
      );
    }
  }

  diskTest(`malformed archived ${sync ? "sync" : "message"} row still stops recovery`, async () => {
    const world = await queuedWorld({
      history: [ownerMessage("100"), ownerMessage("110", { channel_id: "50" })],
      messages: [],
      cursors: { "20": "100", "50": "102" },
      sync,
    });
    const malformed = ownerMessage("1x", { channel_id: "50" });
    world.queue().push("message", malformed, "102");
    world.queue().push("message", ownerMessage("107", { channel_id: "50" }), "102", "20");
    const run = await world.restart();
    expect(await run.outcome).toMatchObject({ code: "DISCORD_INBOUND_PROTOCOL_ERROR", status: 502 });
    expect(world.received).toEqual([]);
    expect(world.cursor("50")).toBe("102");
    expect(world.queue().nextOwner("50", "10", "110", "0", 0)?.payload).toBe(JSON.stringify(malformed));
  });
}
