import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BoardTarget, updateBoard } from "../src/board.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { fakeClock, withState } from "./fakes.ts";

let state: { dir: string; done: () => void };
let requests: HttpRequest[];
let clock: ReturnType<typeof fakeClock>;
const target: BoardTarget = { platform: "discord", to: "40" };
let reply: { status: number; body: string };
const http: Http = async (request) => {
  requests.push(request);
  return { ...reply, headers: {} };
};
const options = () => ({ stateDir: state.dir, target, token: "synthetic", clock, body: "Dori status", http });
const recordPath = () =>
  join(
    state.dir,
    "boards",
    readdirSync(join(state.dir, "boards")).find((f) => f.endsWith(".json"))!,
  );

beforeEach(() => {
  state = withState();
  requests = [];
  clock = fakeClock(Date.parse("2026-01-01T12:00:00Z"));
  reply = { status: 200, body: JSON.stringify({ id: "50" }) };
});
afterEach(() => state.done());

// Board writes fsync their directory, which Bun on Windows rejects.
const posix = test.skipIf(process.platform === "win32");

posix("board posts once, reuses ID after restart and edits only changed content without mentions", async () => {
  expect(await updateBoard(options())).toEqual({ action: "posted", messageId: "50" });
  expect(requests).toHaveLength(1);
  await clock.sleep(60_000);
  expect(await updateBoard(options())).toEqual({ action: "unchanged", messageId: "50" });
  expect(requests).toHaveLength(1);
  expect(await updateBoard({ ...options(), body: "Changed @everyone" })).toEqual({ action: "edited", messageId: "50" });
  expect(requests[1]?.method).toBe("PATCH");
  expect(requests[1]?.url).toEndWith("/channels/40/messages/50");
  expect(JSON.parse(String(requests[1]?.body)).allowed_mentions).toEqual({ parse: [] });
  expect(JSON.parse(readFileSync(recordPath(), "utf8")).pending).toBe(false);
});

for (const status of [408, 503]) {
  posix(`HTTP ${status} leaves a create pending until explicit recovery`, async () => {
    reply = { status, body: "unavailable" };
    let recordAtSend: string | undefined;
    await expect(
      updateBoard({
        ...options(),
        http: async (request) => {
          recordAtSend = readFileSync(recordPath(), "utf8");
          return http(request);
        },
      }),
    ).rejects.toThrow("unconfirmed");
    expect(requests).toHaveLength(1);
    const pending = readFileSync(recordPath(), "utf8");
    expect(recordAtSend).toBe(pending);
    expect(JSON.parse(pending)).toMatchObject({ pending: true });
    expect(JSON.parse(pending)).not.toHaveProperty("messageId");
    reply = { status: 200, body: JSON.stringify({ id: "50" }) };
    await expect(updateBoard(options())).rejects.toThrow("inspect the destination");
    expect(requests).toHaveLength(1);
    expect(readFileSync(recordPath(), "utf8")).toBe(pending);
    expect(await updateBoard({ ...options(), messageId: "50" })).toEqual({ action: "edited", messageId: "50" });
    expect(requests.map((r) => r.method)).toEqual(["POST", "PATCH"]);
    expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({ pending: false, messageId: "50" });
  });
}

posix("a confirmed create refusal clears pending and allows a later explicit create", async () => {
  reply = { status: 403, body: JSON.stringify({ code: 50013, message: "Missing Permissions" }) };
  await expect(updateBoard(options())).rejects.toThrow("403");
  expect(requests.map((r) => r.method)).toEqual(["POST"]);
  expect(readdirSync(join(state.dir, "boards"))).toEqual([]);

  reply = { status: 200, body: JSON.stringify({ id: "50" }) };
  expect(await updateBoard(options())).toEqual({ action: "posted", messageId: "50" });
  expect(requests.map((r) => r.method)).toEqual(["POST", "POST"]);
  expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({ pending: false, messageId: "50" });
});

posix("lost transport, malformed reply and failed edit hold, never create a replacement", async () => {
  const fail: Http = async (request) => {
    requests.push(request);
    throw new Error("lost response from https://example.test/bots/synthetic-token");
  };
  await expect(updateBoard({ ...options(), http: fail })).rejects.toThrow(
    /^board delivery unconfirmed; the write may have succeeded\. Inspect the original destination before attempting recovery; do not resend\.$/,
  );
  expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({ pending: true });
  await expect(updateBoard(options())).rejects.toThrow("unconfirmed");

  reply = { status: 200, body: "{" };
  await expect(updateBoard({ ...options(), messageId: "50" })).rejects.toThrow("unconfirmed");
  expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({ pending: true, messageId: "50" });
  await expect(updateBoard(options())).rejects.toThrow("unconfirmed");

  reply = { status: 200, body: JSON.stringify({ id: "50" }) };
  expect(await updateBoard({ ...options(), messageId: "50" })).toEqual({ action: "edited", messageId: "50" });
  reply = { status: 404, body: JSON.stringify({ message: "Unknown Message" }) };
  await expect(updateBoard({ ...options(), body: "changed" })).rejects.toThrow("404");
  await expect(updateBoard({ ...options(), body: "changed" })).rejects.toThrow("unconfirmed");
  expect(requests.map((r) => r.method)).toEqual(["POST", "PATCH", "PATCH", "PATCH"]);
  await expect(updateBoard({ ...options(), messageId: "99" })).rejects.toThrow("does not match");
});

posix("missing create ID cannot become a confirmed board", async () => {
  reply = { status: 200, body: "{}" };
  await expect(updateBoard(options())).rejects.toThrow(/missing message ID.*Inspect the original destination/);
  await expect(updateBoard(options())).rejects.toThrow("unconfirmed");
  expect(requests).toHaveLength(1);
});

posix("numeric Discord create ID keeps delivery pending without binding a rounded snowflake", async () => {
  reply = { status: 200, body: '{"id":9007199254740993}' };
  await expect(updateBoard(options())).rejects.toThrow("missing message ID");
  expect(JSON.parse(readFileSync(recordPath(), "utf8"))).toMatchObject({ pending: true });
  expect(JSON.parse(readFileSync(recordPath(), "utf8"))).not.toHaveProperty("messageId");
  await expect(updateBoard(options())).rejects.toThrow("unconfirmed");
  expect(requests.map((r) => r.method)).toEqual(["POST"]);

  reply = { status: 200, body: '{"id":"9007199254740993"}' };
  expect(await updateBoard({ ...options(), messageId: "9007199254740993" })).toEqual({
    action: "edited",
    messageId: "9007199254740993",
  });
  expect(requests[1]?.url).toEndWith("/channels/40/messages/9007199254740993");
});

posix("a stored Discord snowflake must be a string and retain every digit", async () => {
  const snowflake = "9007199254740993";
  reply = { status: 200, body: JSON.stringify({ id: snowflake }) };
  expect(await updateBoard(options())).toEqual({ action: "posted", messageId: snowflake });
  const valid = readFileSync(recordPath(), "utf8");
  const invalid = valid.replace(`"messageId":"${snowflake}"`, `"messageId":${snowflake}`);
  writeFileSync(recordPath(), invalid);
  await expect(updateBoard({ ...options(), body: "changed" })).rejects.toThrow("record unreadable");
  expect(requests.map((r) => r.method)).toEqual(["POST"]);
  expect(readFileSync(recordPath(), "utf8")).toBe(invalid);

  writeFileSync(recordPath(), valid);
  expect(await updateBoard({ ...options(), body: "changed" })).toEqual({ action: "edited", messageId: snowflake });
  expect(requests[1]?.url).toEndWith(`/channels/40/messages/${snowflake}`);
});

posix("a second writer cannot create while the first send is pending", async () => {
  const { promise: waiting, resolve: finish } = Promise.withResolvers<void>();
  const { promise: sending, resolve: reached } = Promise.withResolvers<void>();
  const first = updateBoard({
    ...options(),
    http: async (request) => {
      reached();
      await waiting;
      return http(request);
    },
  });
  await sending;
  await expect(updateBoard(options())).rejects.toThrow("another process");
  finish();
  await first;
  expect(requests).toHaveLength(1);
});

posix("Telegram keeps chat/topic identity, one message and a persisted edit ID", async () => {
  reply = { status: 200, body: JSON.stringify({ ok: true, result: { message_id: 99 } }) };
  const tg = { ...options(), target: { platform: "telegram" as const, to: "-100", thread: 7 } };
  expect(await updateBoard(tg)).toEqual({ action: "posted", messageId: "99" });
  expect(JSON.parse(String(requests[0]?.body))).toMatchObject({ chat_id: "-100", message_thread_id: 7 });
  await updateBoard({ ...tg, body: "new" });
  expect(requests[1]?.url).toEndWith("/editMessageText");
  expect(JSON.parse(String(requests[1]?.body)).message_id).toBe(99);
  expect(requests).toHaveLength(2);

  reply = { status: 503, body: "unavailable" };
  await expect(updateBoard({ ...tg, body: "uncertain edit" })).rejects.toThrow("unconfirmed");
  const pending = readFileSync(recordPath(), "utf8");
  await expect(updateBoard({ ...tg, messageId: "100" })).rejects.toThrow("does not match");
  expect(readFileSync(recordPath(), "utf8")).toBe(pending);
  expect(requests).toHaveLength(3);

  reply = { status: 200, body: JSON.stringify({ ok: true, result: { message_id: 99 } }) };
  expect(await updateBoard({ ...tg, messageId: "99" })).toEqual({ action: "edited", messageId: "99" });
  expect(requests[3]?.url).toEndWith("/editMessageText");
  expect(JSON.parse(String(requests[3]?.body)).message_id).toBe(99);
});

posix("unbound Telegram recovery preserves the pending record without touching another topic", async () => {
  const tg = { ...options(), target: { platform: "telegram" as const, to: "-100", thread: 7 } };
  reply = { status: 503, body: "unavailable" };
  await expect(updateBoard(tg)).rejects.toThrow("unconfirmed");
  const pending = readFileSync(recordPath(), "utf8");
  expect(JSON.parse(pending)).toMatchObject({ pending: true });
  expect(JSON.parse(pending)).not.toHaveProperty("messageId");

  // Telegram can accept an edit by chat and message ID alone and return a message from a different topic.
  reply = {
    status: 200,
    body: JSON.stringify({ ok: true, result: { chat: { id: -100 }, message_id: 99, message_thread_id: 8 } }),
  };
  await expect(updateBoard({ ...tg, messageId: "99" })).rejects.toThrow("verify");
  expect(requests.map((r) => new URL(r.url).pathname.split("/").at(-1))).toEqual(["sendMessage"]);
  expect(readFileSync(recordPath(), "utf8")).toBe(pending);
});

test("a Telegram message ID does not establish the first board binding", async () => {
  const tg = { ...options(), target: { platform: "telegram" as const, to: "-100", thread: 7 } };
  reply = { status: 200, body: JSON.stringify({ ok: true, result: { message_id: 99 } }) };
  await expect(updateBoard({ ...tg, messageId: "99" })).rejects.toThrow("verify");
  expect(requests).toHaveLength(0);
  expect(readdirSync(join(state.dir, "boards"))).toEqual([]);
});

test("oversized board bodies cannot post", async () => {
  await expect(updateBoard({ ...options(), body: "x".repeat(2001) })).rejects.toThrow("one message");
  expect(requests).toHaveLength(0);
});

test("damaged board records cannot post", async () => {
  const dir = join(state.dir, "boards");
  mkdirSync(dir);
  const key = createHash("sha256").update(JSON.stringify(target)).digest("hex");
  writeFileSync(join(dir, `${key}.json`), "{broken");
  await expect(updateBoard(options())).rejects.toThrow("record unreadable");
  expect(requests).toHaveLength(0);
});
