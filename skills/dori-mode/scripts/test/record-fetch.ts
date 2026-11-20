import { appendFileSync } from "node:fs";

// Preloaded into a CLI process by send-cli.test.ts and slack-cli.test.ts: every request is appended to
// $DORI_TEST_FETCH_LOG and answered the way Telegram answers a successful call, or with the body that
// $DORI_TEST_FETCH_REPLIES (a JSON object keyed by the URL's last path segment) gives, so no request leaves the machine.
const log = process.env["DORI_TEST_FETCH_LOG"] ?? "";
// A launcher that passes the value through can hand it back empty; an empty reply table is the default.
const replies = JSON.parse(process.env["DORI_TEST_FETCH_REPLIES"] || "{}") as Record<string, unknown>;
const slackRetryAfter = process.env["DORI_TEST_SLACK_RETRY_AFTER"];
let throttledCalls = 0;
if (slackRetryAfter !== undefined) {
  let waits = 0;
  Object.defineProperty(Bun, "sleep", {
    value: async (ms: number) => {
      console.log(`FETCH_SLEEP ${ms}`);
      if (++waits === 6) process.exit(0);
    },
  });
}
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  appendFileSync(
    log,
    `${JSON.stringify({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : null })}\n`,
  );
  const method = String(input).split("/").at(-1) ?? "";
  if (slackRetryAfter !== undefined && method === "subscriptions.thread.getView" && ++throttledCalls <= 5) {
    return new Response('{"ok":false,"error":"ratelimited"}', {
      status: 429,
      headers: { "retry-after": slackRetryAfter },
    });
  }
  const reply = replies[method] ?? { ok: true, result: { message_id: 99 } };
  return new Response(JSON.stringify(reply), { status: 200 });
}) as typeof fetch;
