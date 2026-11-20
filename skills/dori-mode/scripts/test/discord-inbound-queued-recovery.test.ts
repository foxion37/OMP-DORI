import { expect, test } from "bun:test";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { queuedWorld, settle } from "./discord-inbound-live-fakes.ts";

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

for (const missing of [false, true])
  posix(`closed/reopened sync preserves queued 105 with REST 105 ${missing ? "absent" : "present"}`, async () => {
    const world = await queuedWorld({
      history: missing ? [ownerMessage("107")] : [ownerMessage("105"), ownerMessage("107")],
      messages: [ownerMessage("105"), ownerMessage("109")],
      legacy: true,
    });
    await world.start();
    await settle();
    expect(world.received).toEqual(["20:105", "20:107", "20:109"]);
    expect(world.saves).toEqual(["20:105", "20:107", "20:109"]);
    expect(world.cursor()).toBe("109");
    expect(world.queue().first()).toBeNull();
  });

posix("a filtered trailing 107 cannot checkpoint past durable owner 105", async () => {
  const world = await queuedWorld({
    history: ["103", "104", "106", "107"].map((id) => ownerMessage(id, { author: { id: "11" } })),
    messages: [ownerMessage("105"), ownerMessage("109")],
  });
  await world.start();
  await settle();
  expect(world.received).toEqual(["20:105", "20:109"]);
  expect(world.saves).toEqual(["20:105", "20:107", "20:109"]);
  expect(world.cursor()).toBe("109");
  expect(world.queue().first()).toBeNull();
});

for (const sync of [true, false])
  posix(`${sync ? "sync" : "message"} recovery prefix reads older REST gaps before queued owners`, async () => {
    const world = await queuedWorld({
      history: ["103", "104", "107"].map((id) => ownerMessage(id)),
      messages: [ownerMessage("105"), ownerMessage("109")],
      sync,
    });
    const run = await world.start();
    await settle();
    expect(world.received).toEqual(["20:103", "20:104", "20:105", "20:107", "20:109"]);
    expect(world.saves).toEqual(world.received);
    expect(world.queue().first()).toBeNull();
    expect(world.rest.requests.filter((r) => new URL(r.url).searchParams.get("limit") === "100")).toHaveLength(1);
    run.socket.hello();
    run.socket.ready(1);
    await settle();
    const requests = world.rest.requests.length;
    run.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: ownerMessage("110") });
    await settle();
    expect(world.received.at(-1)).toBe("20:110");
    expect(world.cursor()).toBe("110");
    expect(world.rest.requests).toHaveLength(requests);
  });

posix("scope-all recovery reads a queued channel's saved cursor even when discovery omits it", async () => {
  const world = await queuedWorld({
    history: ["103", "104", "107"].map((id) => ownerMessage(id, { channel_id: "21" })),
    messages: ["105", "109"].map((id) => ownerMessage(id, { channel_id: "21" })),
    cursors: { "21": "102" },
    options: { ownerId: "10", channelIds: [], all: true },
  });
  await world.start();
  await settle();
  expect(world.received).toEqual(["21:103", "21:104", "21:105", "21:107", "21:109"]);
  expect(world.cursor("21")).toBe("109");
  expect(world.queue().first()).toBeNull();
});

posix("a new queued channel seeds its lowest known ID, not its first arrival or older REST history", async () => {
  const world = await queuedWorld({
    history: ["103", "104", "107"].map((id) => ownerMessage(id, { channel_id: "50" })),
    messages: ["109", "105"].map((id) => ownerMessage(id, { channel_id: "50" })),
    cursors: {},
    options: { ownerId: "10", channelIds: [], all: true },
  });
  expect(world.cursor("50")).toBeUndefined();
  await world.start();
  await settle();
  expect(world.received).toEqual(["50:105", "50:107", "50:109"]);
  expect(world.cursor("50")).toBe("109");
  expect(world.queue().first()).toBeNull();
});

posix("queued reconciliation preserves watched-channel service order and independent cursors", async () => {
  const world = await queuedWorld({
    history: [
      ownerMessage("103"),
      ownerMessage("107"),
      ...["104", "108"].map((id) => ownerMessage(id, { channel_id: "21" })),
    ],
    messages: [
      ownerMessage("105"),
      ownerMessage("109"),
      ...["106", "110"].map((id) => ownerMessage(id, { channel_id: "21" })),
    ],
    cursors: { "20": "102", "21": "102" },
    options: { ownerId: "10", channelIds: ["20", "21"] },
  });
  await world.start();
  await settle();
  expect(world.received).toEqual(["20:103", "20:105", "20:107", "21:104", "21:106", "21:108", "20:109", "21:110"]);
  expect(world.saves).toEqual(world.received);
  expect([world.cursor("20"), world.cursor("21")]).toEqual(["109", "110"]);
  expect(world.queue().first()).toBeNull();
});

posix("SQL reconciliation orders decimal IDs beyond JavaScript precision and signed SQLite integers", async () => {
  const ids = [
    "9007199254740992",
    "9007199254740993",
    "9223372036854775808",
    "18446744073709551614",
    "18446744073709551615",
  ];
  const world = await queuedWorld({
    history: [ids[0]!, ids[1]!, ids[3]!].map((id) => ownerMessage(id)),
    messages: [ids[4]!, ids[2]!].map((id) => ownerMessage(id)),
    cursors: { "20": "9007199254740991" },
  });
  await world.start();
  await settle();
  expect(world.received).toEqual(ids.map((id) => `20:${id}`));
  expect(world.saves).toEqual(world.received);
  expect(world.cursor()).toBe(ids[4]);
  expect(world.queue().first()).toBeNull();
});

posix("stop drains the active merged backfill but retains later queued work for restart", async () => {
  const world = await queuedWorld({
    history: [ownerMessage("107")],
    messages: [ownerMessage("105"), ownerMessage("109")],
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const run = await world.start(async (message) => {
      if (message.message === "105") {
        entered.resolve();
        await release.promise;
      }
    });
    await entered.promise;
    run.live.close();
    release.resolve();
    expect(await run.outcome).toBeUndefined();
    expect(world.received).toEqual(["20:105", "20:107"]);
    expect(world.cursor()).toBe("107");
    expect(world.queue().first()?.kind).toBe("sync");
    await world.restart();
    await settle();
    expect(world.received).toEqual(["20:105", "20:107", "20:109"]);
    expect(world.cursor()).toBe("109");
    expect(world.queue().first()).toBeNull();
  } finally {
    release.resolve();
  }
});
