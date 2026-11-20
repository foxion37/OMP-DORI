import { expect, test } from "bun:test";
import { Discord } from "../src/messenger/discord.ts";
import { type Http, withBackoff } from "../src/messenger/http.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import { fakeClock } from "./fakes.ts";

test("read 5xx retries keep the original maximum delay", async () => {
  const waits: number[] = [];
  let calls = 0;
  await withBackoff(
    async () => ({ status: ++calls === 1 ? 503 : 200, headers: { "retry-after": "3600" }, body: "{}" }),
    {
      ...fakeClock(0),
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
    { method: "GET", url: "https://example.invalid/read" },
  );
  expect(waits).toEqual([60_000]);
  expect(calls).toBe(2);
});

test("Discord DM creation remains an explicit uncertain write during discovery", async () => {
  let calls = 0;
  const http: Http = async () => {
    calls++;
    return { status: 503, headers: {}, body: "{}" };
  };
  const error = await new Discord(http, fakeClock(0), "t")
    .call("POST", "/users/@me/channels", { recipient_id: "42" })
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ outcome: "uncertain", status: 503 });
  expect(calls).toBe(1);
});

test("cancelling an in-flight Discord write preserves the signal reason and does not retry", async () => {
  const controller = new AbortController();
  const reason = new Error("fixture write cancelled");
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const http: Http = async ({ signal }) => {
    calls++;
    if (!signal) throw new Error("missing request signal");
    const { promise, reject } = Promise.withResolvers<never>();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started.resolve();
    return await promise;
  };
  const client = new Discord(http, fakeClock(0), "t");
  const result = client.call("POST", "/channels/42/messages", { content: "example" }, controller.signal);
  // A missing signal rejects the call rather than leaving the test waiting for the transport.
  await Promise.race([started.promise, result]);
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  expect(calls).toBe(1);
});

test.each([{}, [], null, { id: "" }])("malformed Discord mutation IDs never report success: %j", async (body) => {
  for (const run of [
    (dc: Discord) => dc.startThread("42", "71", "task"),
    (dc: Discord) => dc.setThread("42", { name: "task" }),
    (dc: Discord) => dc.createThread({ id: "42", type: 0 }, "task", { text: "start" }),
    (dc: Discord) => dc.createThread({ id: "42", type: 15 }, "task", { text: "start" }),
    (dc: Discord) => dc.edit("42", "71", "changed"),
  ]) {
    let calls = 0;
    const http: Http = async () => {
      calls++;
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    };
    const error = await run(new Discord(http, fakeClock(0), "t")).catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "uncertain" });
    expect(calls).toBe(1);
  }
});

test.each([{}, [], null, { message_thread_id: 0 }, { message_thread_id: "42" }])(
  "malformed Telegram topic receipts never report success: %j",
  async (result) => {
    let calls = 0;
    const http: Http = async () => {
      calls++;
      return { status: 200, headers: {}, body: JSON.stringify({ ok: true, result }) };
    };
    const error = await new Telegram(http, fakeClock(0), "t").createTopic(1, "task").catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "uncertain" });
    expect(calls).toBe(1);
  },
);

test("transport diagnostics retain only allowlisted error codes", async () => {
  for (const code of ["ECONNRESET", "synthetic-secret"]) {
    const http: Http = async () => {
      throw Object.assign(new Error("https://private.invalid/secret"), { code });
    };
    const error = await new Telegram(http, fakeClock(0), "t").send({ chatId: 1 }, "x").catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "uncertain" });
    if (code === "ECONNRESET") expect(String(error)).toContain(code);
    expect(String(error)).not.toMatch(/private.invalid|secret/);
  }
});
