import { appendFileSync } from "node:fs";

const raw = process.env["DORI_TEST_TELEGRAM_STARTUP"];
const journal = process.env["DORI_TEST_TELEGRAM_REQUESTS"];
const token = process.env["DORI_TELEGRAM_TOKEN"];
if (raw === undefined || journal === undefined || token === undefined)
  throw new Error("Telegram startup fixture is incomplete");
const scenario = JSON.parse(raw) as Record<string, unknown>;

globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const prefix = `/bot${token}/`;
    if (url.origin !== "https://api.telegram.org" || !url.pathname.startsWith(prefix))
      throw new Error("Unexpected Telegram startup endpoint");
    const method = url.pathname.slice(prefix.length);
    const params = JSON.parse(String(init?.body));
    appendFileSync(journal, `${JSON.stringify({ method, params })}\n`, { mode: 0o600 });
    console.log(`STARTUP_REQUEST ${method}`);
    if (scenario["hold"] === method) {
      console.log(`STARTUP_WAIT ${method}`);
      await new Promise<void>((resolve) => {
        process.stdin.once("data", () => {
          process.stdin.pause();
          resolve();
        });
      });
    }
    if (scenario["reject"] === method) throw new Error(`private ${token} https://private-webhook.invalid/key`);
    if (scenario["failure"] === method)
      return new Response(JSON.stringify({ ok: false, description: `private ${token}`, error_code: 401 }), {
        status: 401,
      });
    let result: unknown;
    if (method === "getMe") result = scenario["identity"];
    else if (method === "getWebhookInfo") result = scenario["webhook"];
    else if (method === "getUpdates") result = [];
    else throw new Error("Unexpected Telegram startup method");
    console.log(`STARTUP_RESPONSE ${method}`);
    return new Response(JSON.stringify({ ok: true, result }));
  },
  {
    preconnect() {
      throw new Error("Unexpected Telegram startup preconnect");
    },
  },
);
