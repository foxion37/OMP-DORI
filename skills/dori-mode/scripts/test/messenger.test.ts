import { expect, test } from "bun:test";
import { Discord } from "../src/messenger/discord.ts";
import {
  type Http,
  type HttpRequest,
  type HttpResponse,
  MessengerError,
  UnsafeMessageError,
} from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { htmlTable, splitForTelegram, startThinking, Telegram, THINKING } from "../src/messenger/telegram.ts";
import { fakeClock } from "./fakes.ts";

type Script = (req: HttpRequest, n: number) => HttpResponse;

const fakeHttp = (script: Script) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { http, seen };
};

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body: JSON.stringify(body),
});

const sleeps = () => {
  const waited: number[] = [];
  const clock = {
    ...fakeClock(0),
    sleep: async (ms: number) => {
      waited.push(ms);
    },
  };
  return { clock, waited };
};

test("a Slack post that hits the rate limit waits retry-after seconds, retries, and lands in the thread", async () => {
  const { http, seen } = fakeHttp((_, n) =>
    n === 1
      ? ok({ ok: false, error: "ratelimited" }, 429, { "retry-after": "3" })
      : ok({ ok: true, channel: "C1", ts: "111.222" }),
  );
  const { clock, waited } = sleeps();
  const posted = await new Slack(http, clock, { token: "t" }).post("C1", "deploy finished", "100.1");
  expect(posted).toEqual({ channel: "C1", ts: "111.222" });
  expect(waited).toEqual([3000]);
  expect(JSON.parse(String(seen[1]?.body))).toEqual({ channel: "C1", text: "deploy finished", thread_ts: "100.1" });
});

test("a Slack error that is not transient fails at once with the API error, without retries", async () => {
  const { http, seen } = fakeHttp(() => ok({ ok: false, error: "channel_not_found" }));
  const err = await new Slack(http, sleeps().clock, { token: "t" }).edit("C9", "1.2", "x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MessengerError);
  expect((err as MessengerError).code).toBe("channel_not_found");
  expect(seen).toHaveLength(1);
});

test("text carrying a $( substitution is refused before any request goes out, on every platform", async () => {
  const { http, seen } = fakeHttp(() => ok({ ok: true }));
  const clock = sleeps().clock;
  await expect(new Slack(http, clock, { token: "t" }).post("C1", "result: $(whoami)")).rejects.toBeInstanceOf(
    UnsafeMessageError,
  );
  await expect(new Telegram(http, clock, "b").send({ chatId: 1 }, "$(id)")).rejects.toBeInstanceOf(UnsafeMessageError);
  await expect(new Discord(http, clock, "b").send("9", "x $(ls)")).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(seen).toHaveLength(0);
});

test("a Slack upload asks for an upload URL, sends the bytes there, then shares the file into the thread", async () => {
  const { http, seen } = fakeHttp((req) => {
    if (req.url.endsWith("files.getUploadURLExternal"))
      return ok({ ok: true, upload_url: "https://files.example/up/1", file_id: "F1" });
    if (req.url.startsWith("https://files.example")) return { status: 200, headers: {}, body: "OK" };
    return ok({ ok: true });
  });
  const id = await new Slack(http, sleeps().clock, { token: "t" }).upload(
    "C1",
    "report.png",
    new Uint8Array([1, 2, 3]),
    "5.6",
  );
  expect(id).toBe("F1");
  expect(seen.map((r) => r.url.split("/").pop())).toEqual([
    "files.getUploadURLExternal",
    "1",
    "files.completeUploadExternal",
  ]);
  expect(JSON.parse(String(seen[2]?.body))).toMatchObject({ channel_id: "C1", thread_ts: "5.6" });
});

test("a Telegram reply starts as Thinking…, streams drafts no faster than the interval, then persists as a real message", async () => {
  const { http, seen } = fakeHttp((req) =>
    ok({ ok: true, result: req.url.endsWith("sendMessage") ? { message_id: 77 } : true }),
  );
  const clock = fakeClock(10_000);
  const tg = new Telegram(http, clock, "b");
  const s = await startThinking(tg, clock, { chatId: 5, threadId: 9 });
  clock.at += 100;
  await s.push("Half");
  clock.at += 900;
  await s.push("Half done");
  const id = await s.finish("All done");
  const calls = seen.map((r) => [r.url.split("/").pop(), JSON.parse(String(r.body)).text]);
  expect(calls).toEqual([
    ["sendMessageDraft", THINKING],
    ["sendMessageDraft", "Half done"],
    ["sendMessage", "All done"],
  ]);
  expect(id).toBe(77);
  expect(JSON.parse(String(seen[0]?.body)).message_thread_id).toBe(9);
});

test("Telegram's retry_after in the error body is honored", async () => {
  const { http } = fakeHttp((_, n) =>
    n === 1
      ? ok({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, 429)
      : ok({ ok: true, result: { message_id: 1 } }),
  );
  const { clock, waited } = sleeps();
  await new Telegram(http, clock, "b").send({ chatId: 1 }, "hi");
  expect(waited).toEqual([7000]);
});

test("a rich Telegram table escapes HTML and lines columns up inside one pre block", () => {
  expect(
    htmlTable(
      ["name", "n"],
      [
        ["a<b", "10"],
        ["c", "2"],
      ],
    ),
  ).toBe("<pre>name  n \n----  --\na&lt;b   10\nc     2 </pre>");
});

test("Discord messages are sent without pinging anyone and edited in place; threads are named and archived", async () => {
  const { http, seen } = fakeHttp((req) =>
    ok(req.method === "POST" && req.url.endsWith("/messages") ? { id: "M1" } : { id: "T1" }),
  );
  const dc = new Discord(http, sleeps().clock, "b");
  expect(await dc.send("C1", "hello @everyone")).toBe("M1");
  await dc.edit("C1", "M1", "hello again");
  expect(await dc.startThread("C1", "M1", "[working] fix login")).toBe("T1");
  await dc.setThread("T1", { name: "[done] fix login", archived: true });
  expect(JSON.parse(String(seen[0]?.body)).allowed_mentions).toEqual({ parse: [] });
  expect(seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}`)).toEqual([
    "POST /channels/C1/messages",
    "PATCH /channels/C1/messages/M1",
    "POST /channels/C1/messages/M1/threads",
    "PATCH /channels/T1",
  ]);
});

test("a long Telegram report preserves every paragraph and returns the last part's message id", async () => {
  const { http, seen } = fakeHttp((req, n) => {
    const body = JSON.parse(String(req.body));
    if (body.text.length > 4096 || Buffer.from(body.text).toString("utf8") !== body.text)
      return ok({ ok: false, error_code: 400, description: "invalid message text" }, 400);
    return ok({ ok: true, result: { message_id: 70 + n } });
  });
  const tg = new Telegram(http, sleeps().clock, "b");
  const long = `${"x".repeat(199)}\n`.repeat(40);
  expect(await tg.send({ chatId: 1, threadId: 9 }, long)).toBe(72);
  const bodies = seen.map((r) => JSON.parse(String(r.body)));
  const texts = bodies.map((b) => b.text as string);
  expect(texts.map((text) => text.length)).toEqual([4000, 4000]);
  expect(texts.join("")).toBe(long);
  expect(bodies.every((b) => b.chat_id === 1 && b.message_thread_id === 9)).toBe(true);
  expect(seen.every((r) => r.url.endsWith("/sendMessage"))).toBe(true);
});

test("an oversized Telegram edit fails before changing the target or posting another message", async () => {
  let target = "original";
  const posted: string[] = [];
  const { http, seen } = fakeHttp((req) => {
    const text = JSON.parse(String(req.body)).text as string;
    if (req.url.endsWith("/editMessageText")) target = text;
    else posted.push(text);
    return ok({ ok: true, result: { message_id: 8 } });
  });
  const tg = new Telegram(http, sleeps().clock, "b");
  await expect(tg.edit({ chatId: 1 }, 42, "y".repeat(4097))).rejects.toBeInstanceOf(MessengerError);
  expect({ target, posted, requests: seen.length }).toEqual({ target: "original", posted: [], requests: 0 });
});

test("Telegram splits preserve exact text at the UTF-16 boundary without cutting a surrogate pair", () => {
  expect(splitForTelegram("short")).toEqual(["short"]);
  expect(splitForTelegram("")).toEqual([""]);
  expect(splitForTelegram("z".repeat(4096))).toEqual(["z".repeat(4096)]);
  expect(splitForTelegram("z".repeat(4097)).map((p) => p.length)).toEqual([4096, 1]);
  for (const prefix of [4094, 4095, 4096]) {
    const text = `${"x".repeat(prefix)}\u{1f600}tail`;
    const parts = splitForTelegram(text);
    expect(parts.every((part) => part.length <= 4096 && Buffer.from(part).toString("utf8") === part)).toBe(true);
    expect(parts.join("")).toBe(text);
  }
});

test("read receipts replace the message's single reaction without posting a message", async () => {
  const reactions = new Map<number, string>();
  const { http, seen } = fakeHttp((req) => {
    const body = JSON.parse(String(req.body));
    if (!req.url.endsWith("/setMessageReaction") || body.chat_id !== 1 || body.reaction.length !== 1)
      return ok({ ok: false, error_code: 400, description: "invalid reaction target" }, 400);
    reactions.set(body.message_id, body.reaction[0].emoji);
    return ok({ ok: true, result: true });
  });
  const tg = new Telegram(http, sleeps().clock, "b");
  await tg.react({ chatId: 1 }, 55, "👀");
  await tg.react({ chatId: 1 }, 55, "👀");
  await tg.react({ chatId: 1 }, 55, "👍");
  expect([...reactions]).toEqual([[55, "👍"]]);
  expect(seen).toHaveLength(3);
  expect(seen.every((req) => req.url.endsWith("/setMessageReaction"))).toBe(true);
});
