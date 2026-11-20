import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { Discord } from "../src/messenger/discord.ts";
import { fetchHttp, type Http, type HttpRequest, type HttpResponse, withBackoff } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import { fakeClock } from "./fakes.ts";

const response = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body: JSON.stringify(body) });
const clock = () => {
  const waits: number[] = [];
  return {
    waits,
    clock: {
      ...fakeClock(0),
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    },
  };
};

for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
  test.each([408, 500, 502, 503])(`${method} HTTP %i after a remote effect is not retried`, async (status) => {
    let effects = 0;
    const http: Http = async () => {
      effects++;
      return response(status, { error: "lost acknowledgement" });
    };
    const time = clock();
    const error = await withBackoff(http, time.clock, { method, url: "https://example.invalid/mutation" }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ status, outcome: "uncertain", code: "DELIVERY_UNCERTAIN" });
    expect(error).toHaveProperty("message", expect.stringContaining("do not resend"));
    expect(effects).toBe(1);
    expect(time.waits).toEqual([]);
  });
}

test.each(["5xx", "disconnected"])(
  "a committed mutation with a %s response is never retransmitted",
  async (failure) => {
    let effects = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        effects++;
        if (failure === "5xx") res.writeHead(503).end("lost acknowledgement");
        else req.socket.destroy();
      });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");
      const base = `http://127.0.0.1:${address.port}`;
      const error = await new Discord(fetchHttp, clock().clock, "synthetic-token", base)
        .send("42", "commit then lose the response")
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        outcome: "uncertain",
        code: "DELIVERY_UNCERTAIN",
        status: failure === "5xx" ? 503 : 0,
      });
      expect(String(error)).not.toContain("synthetic-token");
      expect(effects).toBe(1);
    } finally {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      await closed.promise;
    }
  },
);

test("GET and explicitly read-only RPC calls retain bounded 5xx retries", async () => {
  for (const call of [
    (http: Http) => new Discord(http, clock().clock, "t").channel("42"),
    (http: Http) => new Telegram(http, clock().clock, "t").call("getUpdates", { offset: 1 }),
    (http: Http) => new Slack(http, clock().clock, { token: "t" }).call("conversations.replies", { channel: "C1" }),
  ]) {
    let attempts = 0;
    const http: Http = async () =>
      ++attempts === 1 ? response(503, {}) : response(200, { ok: true, result: [], id: "42" });
    await call(http);
    expect(attempts).toBe(2);
  }
});

test("transport errors never echo token-bearing URLs, headers, or response bodies", async () => {
  const http: Http = async (req) => {
    throw new Error(req.url + JSON.stringify(req.headers));
  };
  const error = await new Telegram(http, clock().clock, "synthetic-secret")
    .send({ chatId: 1 }, "x")
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ outcome: "uncertain" });
  expect(String(error)).toContain("telegram sendMessage");
  expect(String(error)).not.toMatch(/synthetic-secret|api.telegram.org|Content-Type/);
});

test("known 429 rejections remain retryable, while 4xx rejections are not uncertain", async () => {
  let attempts = 0;
  const time = clock();
  const http: Http = async () => (++attempts === 1 ? response(429, { retry_after: 2 }) : response(200, { id: "M1" }));
  expect(await new Discord(http, time.clock, "t").send("42", "x")).toEqual(["M1"]);
  expect(time.waits).toEqual([2000]);
  const rejected = await new Discord(async () => response(403, { message: "denied" }), time.clock, "t")
    .send("42", "x")
    .catch((e: unknown) => e);
  expect(rejected).toMatchObject({ status: 403, outcome: "rejected" });
});

test.each(["not JSON", "null", "{}", '{"ok":true}'])("malformed mutation receipts are uncertain: %s", async (body) => {
  for (const send of [
    (http: Http) => new Discord(http, clock().clock, "t").send("42", "x"),
    (http: Http) => new Telegram(http, clock().clock, "t").send({ chatId: 1 }, "x"),
    (http: Http) => new Slack(http, clock().clock, { token: "t" }).post("C1", "x"),
  ]) {
    let attempts = 0;
    const error = await send(async () => {
      attempts++;
      return { status: 200, headers: {}, body };
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "uncertain" });
    expect(attempts).toBe(1);
  }
});

test("partial sends retain confirmed IDs and stop at the uncertain part", async () => {
  for (const platform of ["discord", "telegram"] as const) {
    const requests: HttpRequest[] = [];
    const http: Http = async (req) => {
      requests.push(req);
      return requests.length === 1
        ? response(200, { id: "71", ok: true, result: { message_id: 71 } })
        : response(503, {});
    };
    const error = await (
      platform === "discord"
        ? new Discord(http, clock().clock, "t").send("42", "x".repeat(5000))
        : new Telegram(http, clock().clock, "t").send({ chatId: 1 }, "x".repeat(9000))
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "uncertain" });
    expect(String(error)).toContain("already posted: 71");
    expect(requests).toHaveLength(2);
  }
});

test.each([
  { header: "60", wait: 60_000 },
  { header: new Date(12_000).toUTCString(), wait: 12_000 },
  { header: "3600", wait: undefined },
])("Discord honors Retry-After within budget and surfaces longer waits: %j", async ({ header, wait }) => {
  let calls = 0;
  const time = clock();
  const http: Http = async () =>
    ++calls === 1 ? { status: 429, headers: { "retry-after": header }, body: "{}" } : response(200, { id: "M1" });
  const sending = new Discord(http, time.clock, "t").send("42", "x");
  if (wait === undefined) {
    await expect(sending).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMIT_WAIT_EXCEEDED",
      outcome: "rejected",
      message: expect.stringContaining("Retry-After exceeds the 60s automatic retry limit"),
    });
    expect(time.waits).toEqual([]);
    expect(calls).toBe(1);
  } else {
    expect(await sending).toEqual(["M1"]);
    expect(time.waits).toEqual([wait]);
    expect(calls).toBe(2);
  }
});

test("server-error RPC envelopes and unknown RPC methods never acquire retry permission", async () => {
  for (const operation of ["internal_error", "fatal_error", "request_timeout", "service_unavailable", "unknown"]) {
    let calls = 0;
    const http: Http = async () => {
      calls++;
      return response(operation === "unknown" ? 503 : 200, { ok: false, error: operation });
    };
    const error = await new Slack(http, clock().clock, { token: "t" })
      .call(operation === "unknown" ? "future.write" : "chat.postMessage", {})
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "uncertain" });
    expect(calls).toBe(1);
  }
  const error = await new Telegram(async () => response(200, { ok: false, error_code: 500 }), clock().clock, "t")
    .call("sendMessage", {})
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ outcome: "uncertain" });
});
