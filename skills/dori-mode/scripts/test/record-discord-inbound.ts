import type { TestDiscordMessage } from "./discord-inbound-fakes.ts";

// Stateful local REST fixture for the public CLI; no request leaves this process.
let polls = 0;
let requests = 0;
const delays: number[] = [];
const scenario = process.env["DORI_TEST_DISCORD_CASE"];
const message = (id: string, author: string, content: string, bot = false) => ({
  id,
  channel_id: "20",
  type: 0,
  author: { id: author, bot },
  content,
});
const history: TestDiscordMessage[] = [message("100", "10", "private baseline history")];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  requests++;
  const url = new URL(String(input));
  if (url.origin !== "https://discord.com") throw new Error("unexpected network origin in Discord test");
  const headers = new Headers(init?.headers);
  if (headers.get("Authorization") !== "Bot synthetic-inbound-token") {
    return new Response('{"diagnostic":"private authentication payload"}', { status: 401 });
  }
  let body: unknown;
  if (url.pathname === "/api/v10/users/@me") body = { id: "99", bot: true };
  else if (url.pathname === "/api/v10/applications/@me") body = { flags: scenario === "intent" ? 0 : 1 << 19 };
  else if (url.pathname === "/api/v10/channels/20/messages") {
    if (scenario === "permissions") return new Response('{"diagnostic":"private channel body"}', { status: 403 });
    const limit = Number(url.searchParams.get("limit"));
    if (limit === 100 && !url.searchParams.has("before")) {
      polls++;
      if (polls === 1)
        history.push(message("101", "10", "first owner text"), message("102", "11", "private other user"));
      if (polls === 2) {
        history.push(
          { ...message("103", "10", "owner reply"), type: 19, message_reference: { message_id: "101" } },
          message("104", "99", "private self bot", true),
        );
      }
    }
    const before = url.searchParams.get("before");
    body = [...history]
      .filter((item) => before === null || BigInt(item.id) < BigInt(before))
      .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
      .slice(0, limit);
  } else throw new Error("unexpected Discord REST endpoint in test");
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

Object.defineProperty(Bun, "sleep", {
  value: async (ms: number) => {
    delays.push(ms);
    if (delays.length === 2) {
      console.log(`DISCORD_INBOUND_QA ${JSON.stringify({ delays, polls, requests })}`);
      process.exit(0);
    }
  },
});
