import { expect, test } from "bun:test";

import { type Http, type HttpResponse, MessengerError } from "../src/messenger/http.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import { fakeClock } from "./fakes.ts";

const reply = (result: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ ok: true, result }),
});

test.each([4095, 4096, 4097, 8192, 8193])(
  "plain Telegram sends respect the 4096 boundary at %i units",
  async (size) => {
    const posted: string[] = [];
    const http: Http = async (req) => {
      const body = JSON.parse(String(req.body));
      if (
        !req.url.endsWith("/sendMessage") ||
        body.text.length > 4096 ||
        Buffer.from(body.text).toString("utf8") !== body.text
      )
        return { status: 400, headers: {}, body: '{"ok":false,"description":"invalid text"}' };
      posted.push(body.text);
      return reply({ message_id: posted.length });
    };
    const text = "x".repeat(size);
    const id = await new Telegram(http, fakeClock(0), "b").send({ chatId: 1 }, text);
    expect(posted).toHaveLength(Math.ceil(size / 4096));
    expect(posted.join("")).toBe(text);
    expect(id).toBe(posted.length);
  },
);

test.each([
  ["ASCII boundary", "x".repeat(4096), false],
  ["non-BMP boundary", "\u{1f600}".repeat(2048), false],
  ["short HTML", "<b>short &amp; intact</b>", true],
] as const)("a %s Telegram edit keeps one existing message", async (_, text, rich) => {
  const messages = new Map([[42, "original"]]);
  let calls = 0;
  const http: Http = async (req) => {
    calls++;
    const body = JSON.parse(String(req.body));
    if (!req.url.endsWith("/editMessageText") || !messages.has(body.message_id))
      return { status: 400, headers: {}, body: '{"ok":false,"description":"unknown message"}' };
    messages.set(body.message_id, body.text);
    return reply(true);
  };
  await new Telegram(http, fakeClock(0), "b").edit({ chatId: 1, threadId: 9 }, 42, text, rich);
  expect([...messages]).toEqual([[42, text]]);
  expect(calls).toBe(1);
});

test("an HTML send keeps tags and entities in one request even when markup exceeds the plain-text bound", async () => {
  const text = `<b>${"x".repeat(4090)}&amp;</b>`;
  const posted: string[] = [];
  const http: Http = async (req) => {
    const body = JSON.parse(String(req.body));
    if (
      !req.url.endsWith("/sendMessage") ||
      body.parse_mode !== "HTML" ||
      !body.text.startsWith("<b>") ||
      !body.text.endsWith("&amp;</b>")
    )
      return { status: 400, headers: {}, body: '{"ok":false,"description":"incomplete HTML"}' };
    posted.push(body.text);
    return reply({ message_id: posted.length });
  };
  expect(await new Telegram(http, fakeClock(0), "b").send({ chatId: 1 }, text, true)).toBe(1);
  expect(posted).toEqual([text]);
});

test.each([
  ["non-BMP plain text", `${"\u{1f600}".repeat(2048)}x`, false],
  ["HTML markup", `<b>${"x".repeat(4090)}&amp;</b>`, true],
] as const)("an oversized %s edit fails actionably before any mutation", async (_, text, rich) => {
  const messages = ["original"];
  let calls = 0;
  const http: Http = async () => {
    calls++;
    messages[0] = "mutated";
    return reply(true);
  };
  const error = await new Telegram(http, fakeClock(0), "b")
    .edit({ chatId: 1 }, 42, text, rich)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MessengerError);
  expect((error as Error).message).toMatch(/shorten.*--edit/);
  expect({ messages, calls }).toEqual({ messages: ["original"], calls: 0 });
});

test.each([
  "not JSON",
  "null",
  "[]",
  '{"ok":true}',
  '{"ok":true,"result":null}',
  '{"ok":true,"result":{"message_id":"7"}}',
  '{"ok":true,"result":{"message_id":0}}',
])("a malformed Telegram response stops a long send before another part: %s", async (body) => {
  let calls = 0;
  const http: Http = async () => {
    calls++;
    return { status: 200, headers: {}, body };
  };
  await expect(new Telegram(http, fakeClock(0), "b").send({ chatId: 1 }, "x".repeat(8193))).rejects.toBeInstanceOf(
    MessengerError,
  );
  expect(calls).toBe(1);
});
