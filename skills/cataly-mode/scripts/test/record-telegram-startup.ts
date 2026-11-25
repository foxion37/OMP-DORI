import { appendFileSync } from "node:fs";

const raw = process.env["CATALY_TEST_TELEGRAM_STARTUP"];
const journal = process.env["CATALY_TEST_TELEGRAM_REQUESTS"];
const token = process.env["CATALY_TELEGRAM_TOKEN"];
if (raw === undefined || journal === undefined || token === undefined)
  throw new Error("Telegram startup fixture is incomplete");
const scenario = JSON.parse(raw) as Record<string, unknown>;
const platform = process.env["CATALY_TEST_PLATFORM"];
if (platform !== undefined)
  Object.defineProperty(process, "platform", {
    ...Object.getOwnPropertyDescriptor(process, "platform")!,
    value: platform,
  });

globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const prefix = `/bot${token}/`;
    if (url.origin !== "https://api.telegram.org" || !url.pathname.startsWith(prefix))
      throw new Error("Unexpected Telegram startup endpoint");
    const method = url.pathname.slice(prefix.length);
    const body = init?.body;
    const params = body instanceof FormData ? { photo: body.get("photo") } : JSON.parse(String(body));
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
    else if (method === "getUserProfilePhotos") result = scenario["photos"];
    else if (method === "setMyName") result = true;
    else if (method === "setMyProfilePhoto") {
      const image = body instanceof FormData ? body.get("avatar") : null;
      const expected = Bun.file(new URL("../../assets/cataly-avatar.jpg", import.meta.url));
      if (
        !(image instanceof File) ||
        image.type !== "image/jpeg" ||
        image.name !== "cataly-avatar.jpg" ||
        !Buffer.from(await image.arrayBuffer()).equals(Buffer.from(await expected.arrayBuffer()))
      )
        throw new Error("Unexpected Telegram default profile photo");
      result = true;
    } else if (method === "getUpdates") result = scenario["updates"] ?? [];
    else if (method === "setMessageReaction" && Array.isArray(scenario["updates"])) result = true;
    else if (method === "sendMessage" && scenario["sent"] !== undefined) result = scenario["sent"];
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
