import { afterEach, expect, test } from "bun:test";
import type { Http } from "../src/messenger/http.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import type { TgUpdate } from "../src/messenger/telegram-inbound-update.ts";
import { ERROR_BACKOFF_CAP_MS, pollTelegramInbound, telegramInboundLoop } from "../src/messenger/telegram-inbound.ts";
import { fakeClock, withState } from "./fakes.ts";
import { telegramTestStore } from "./telegram-win32-fixtures.ts";

const states: ReturnType<typeof withState>[] = [];
afterEach(() => {
  for (const state of states.splice(0)) state.done();
});
const setup = (batches: readonly unknown[]) => {
  const state = withState();
  states.push(state);
  const bodies: Record<string, unknown>[] = [];
  const http: Http = async (request) => {
    const batch = batches[bodies.length];
    if (batch === undefined || typeof request.body !== "string") throw new Error("Unexpected Telegram poll");
    bodies.push(JSON.parse(request.body));
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true, result: batch }) };
  };
  return { store: telegramTestStore(state.dir, 900), tg: new Telegram(http, fakeClock(0), "synthetic"), bodies };
};
const message = (id: number, text = String(id)): TgUpdate => ({
  update_id: id,
  message: { message_id: id, date: 1700, from: { id: 5250 }, chat: { id: 5250, type: "private" }, text },
});
const owner = { ownerId: 5250 };

test("offset expires exactly at 24 hours and a clock rollback never borrows a future cursor", async () => {
  const observedAt = 100_000_000;
  for (const [age, fresh] of [
    [0, true],
    [86_399_999, true],
    [86_400_000, false],
    [86_400_001, false],
    [-1, false],
  ] as const) {
    const { tg, store, bodies } = setup([[]]);
    store.save({ offset: 1001, observedAt, seen: [] });
    await pollTelegramInbound(tg, store, owner, undefined, () => observedAt + age);
    if (fresh) expect(bodies[0]?.["offset"]).toBe(1001);
    else expect(bodies[0]).not.toHaveProperty("offset");
    expect(store.load()?.observedAt).toBe(observedAt);
    expect(bodies[0]?.["limit"]).toBe(100);
  }
});

test("an empty poll does not refresh the cursor epoch, even while clearing acknowledged receipts", async () => {
  const { tg, store, bodies } = setup([[message(1000)], [], [message(5)]]);
  await pollTelegramInbound(tg, store, owner, undefined, () => 1000);
  expect(store.load()?.seen).toHaveLength(1);
  await pollTelegramInbound(tg, store, owner, undefined, () => 2000);
  expect(store.load()).toEqual({ offset: 1001, observedAt: 1000, seen: [] });
  const third = await pollTelegramInbound(tg, store, owner, undefined, () => 86_401_000);
  expect(third.inbound.map((item) => item.updateId)).toEqual([5]);
  expect(bodies[2]).not.toHaveProperty("offset");
});

test("same-second A to B to A edits survive, while replay ignores volatile profile and file IDs", async () => {
  const edits: TgUpdate[] = ["A", "B", "A"].map((text, index) => ({
    update_id: index + 10,
    edited_message: {
      message_id: 4,
      date: 1700,
      edit_date: 1800,
      from: { id: 5250, username: "before" },
      chat: { id: 5250, type: "private" },
      text,
      document: { file_id: "before", file_unique_id: "stable" },
    },
  }));
  const replay = edits.map((update) => ({
    ...update,
    edited_message: {
      ...update.edited_message,
      from: { id: 5250, username: "after" },
      document: { file_id: "rotated", file_unique_id: "stable" },
    },
  }));
  const { tg, store } = setup([edits, replay]);
  expect((await pollTelegramInbound(tg, store, owner, undefined, () => 2000)).inbound.map((item) => item.text)).toEqual(
    ["A", "B", "A"],
  );
  expect((await pollTelegramInbound(tg, store, owner, undefined, () => 1000)).inbound).toEqual([]);
});

test("a reused update ID is not enough to suppress a new revision lacking edit_date", async () => {
  const original = message(10, "first").message;
  const { tg, store } = setup([
    [{ update_id: 10, edited_message: original }],
    [{ update_id: 10, edited_message: { ...original, text: "second" } }],
    [message(10, "new message")],
  ]);
  const first = await pollTelegramInbound(tg, store, owner, undefined, () => 3000);
  const second = await pollTelegramInbound(tg, store, owner, undefined, () => 2000);
  const third = await pollTelegramInbound(tg, store, owner, undefined, () => 1000);
  expect([first, second, third].flatMap((result) => result.inbound.map((item) => item.text))).toEqual([
    "first",
    "second",
    "new message",
  ]);
});

test("an early emit failure preserves later matched receipts after a scope change and rollback", async () => {
  const group: TgUpdate = {
    update_id: 11,
    message: { ...message(11).message, chat: { id: -100, type: "supergroup" } },
  };
  const batch = [message(10), group, message(12)];
  const { tg, store, bodies } = setup([batch, batch, batch]);
  expect(
    (await pollTelegramInbound(tg, store, owner, undefined, () => 3000)).inbound.map((item) => item.updateId),
  ).toEqual([10, 12]);
  const saved = store.load();
  const scope = { ...owner, groupChatId: -100 };
  await expect(
    pollTelegramInbound(
      tg,
      store,
      scope,
      () => {
        throw new Error("emit interrupted");
      },
      () => 2000,
    ),
  ).rejects.toThrow("emit interrupted");
  expect(store.load()?.offset).toBe(11);
  expect(store.load()?.seen).toEqual(saved?.seen);
  expect(
    (await pollTelegramInbound(tg, store, scope, undefined, () => 1000)).inbound.map((item) => item.updateId),
  ).toEqual([11]);
  expect(bodies[1]).not.toHaveProperty("offset");
  expect(bodies[2]).not.toHaveProperty("offset");
}, 30_000);

test("receipts stay within the current 100-update batch without evicting its first emission", async () => {
  const first = Array.from({ length: 100 }, (_, index) => message(index + 1));
  const second = Array.from({ length: 100 }, (_, index) => message(index + 101));
  const { tg, store, bodies } = setup([first, first, second, []]);
  expect((await pollTelegramInbound(tg, store, owner, undefined, () => 3000)).inbound).toHaveLength(100);
  expect(store.load()?.seen).toHaveLength(100);
  expect((await pollTelegramInbound(tg, store, owner, undefined, () => 2000)).inbound).toEqual([]);
  expect((await pollTelegramInbound(tg, store, owner, undefined, () => 4000)).inbound).toHaveLength(100);
  expect(bodies[2]?.["offset"]).toBe(101);
  expect(store.load()?.seen).toHaveLength(100);
  await pollTelegramInbound(tg, store, owner, undefined, () => 5000);
  expect(store.load()).toEqual({ offset: 201, observedAt: 4000, seen: [] });
}, 30_000);

test("invalid update IDs or oversized API batches cannot mutate the cursor or emit", async () => {
  for (const batch of [
    [{ update_id: -1 }],
    [{ update_id: Number.MAX_SAFE_INTEGER }],
    [{ update_id: "5" }],
    Array.from({ length: 101 }, (_, index) => message(index)),
  ]) {
    const { tg, store } = setup([batch]);
    store.save({ offset: 20, observedAt: 1000, seen: [] });
    const emitted: unknown[] = [];
    await expect(
      pollTelegramInbound(
        tg,
        store,
        owner,
        (item) => emitted.push(item),
        () => 1000,
      ),
    ).rejects.toThrow("invalid update IDs or batch size");
    expect(emitted).toEqual([]);
    expect(store.load()).toEqual({ offset: 20, observedAt: 1000, seen: [] });
  }
});

test("failed store initialization uses the existing retry loop and successful initialization is cached", async () => {
  const { tg, store, bodies } = setup([[message(1)], []]);
  let opens = 0;
  const warnings: string[] = [];
  const sleeps: number[] = [];
  const open = async () => {
    if (++opens === 1) throw new Error("identity temporarily unavailable");
    return store;
  };
  await expect(
    telegramInboundLoop(
      tg,
      open,
      owner,
      1,
      undefined,
      (warning) => warnings.push(warning),
      async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) throw new Error("test stop");
      },
    ),
  ).rejects.toThrow("test stop");
  expect(opens).toBe(2);
  expect(warnings).toEqual(["identity temporarily unavailable"]);
  // A failed poll/open backs off at the capped error delay, not the whole loop interval.
  expect(sleeps).toEqual([ERROR_BACKOFF_CAP_MS, 60_000]);
  expect(bodies).toHaveLength(2);
});
