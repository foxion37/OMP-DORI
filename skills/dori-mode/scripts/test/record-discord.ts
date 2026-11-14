import { appendFileSync, readFileSync } from "node:fs";
import type { DiscordRoute } from "./discord-fakes.ts";

// Preloaded only into accepted-operation CLI scenarios. No fetch reaches the network.
const log = process.env["DORI_TEST_FETCH_LOG"] ?? "";
const routes = JSON.parse(readFileSync(process.env["DORI_TEST_DISCORD_ROUTES"] ?? "", "utf8")) as Record<
  string,
  DiscordRoute
>;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const key = `${init?.method ?? "GET"} ${url.pathname.replace(/^\/api\/v10/, "")}${url.search}`;
  appendFileSync(
    log,
    `${JSON.stringify({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : null })}\n`,
  );
  const route = routes[key];
  if (route === undefined) return new Response(JSON.stringify({ message: "Unknown" }), { status: 404 });
  if (route.failure === "fetch") throw new Error("synthetic transport failure");
  if (route.failure === "body") {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("synthetic body failure"));
        },
      }),
    );
  }
  const status = route.status ?? 200;
  return new Response(status === 204 ? null : (route.raw ?? JSON.stringify(route.body)), { status });
}) as typeof fetch;
