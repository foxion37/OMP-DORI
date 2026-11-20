import { appendFileSync, readFileSync } from "node:fs";
import type { BodyInit } from "bun";
import type { DiscordRoute } from "./discord-fakes.ts";

// Preloaded only into accepted-operation CLI scenarios. No fetch reaches the network.
const log = process.env["DORI_TEST_FETCH_LOG"] ?? "";
const routes = JSON.parse(readFileSync(process.env["DORI_TEST_DISCORD_ROUTES"] ?? "", "utf8")) as Record<
  string,
  DiscordRoute
>;

const calls = new Map<string, number>();

class StreamOnlyResponse extends Response {
  override readonly arrayBuffer = async (): Promise<ArrayBuffer> => {
    throw new Error("whole-body buffering is forbidden");
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const key = `${init?.method ?? "GET"} ${url.pathname.replace(/^\/api\/v10/, "")}${url.search}`;
  appendFileSync(
    log,
    `${JSON.stringify({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : null })}\n`,
  );
  const listed = routes[key];
  // A sequence answers successive requests in order and repeats its last answer.
  const served = calls.get(key) ?? 0;
  calls.set(key, served + 1);
  const route = listed?.sequence ? listed.sequence[Math.min(served, listed.sequence.length - 1)] : listed;
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
  let body: BodyInit | null | undefined = status === 204 ? null : (route.raw ?? JSON.stringify(route.body));
  if (route.base64 !== undefined) body = Buffer.from(route.base64, "base64");
  if (route.chunks) {
    const chunks = route.chunks;
    let index = 0;
    body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => {
              appendFileSync(log, `${JSON.stringify({ key: "BODY_ABORT", body: { index } })}\n`);
              controller.error(new Error("download aborted"));
            },
            { once: true },
          );
        },
        pull(controller) {
          appendFileSync(log, `${JSON.stringify({ key: "BODY_READ", body: { index } })}\n`);
          if (route.streamFailureAfter === index) controller.error(new Error("synthetic midstream failure"));
          else if (index === chunks.length) controller.close();
          else controller.enqueue(Buffer.from(chunks[index++]!, "base64"));
        },
      },
      { highWaterMark: 0 },
    );
  }
  const ResponseType = route.base64 !== undefined || route.chunks ? StreamOnlyResponse : Response;
  return new ResponseType(body, { status, ...(route.headers ? { headers: route.headers } : {}) });
}) as typeof fetch;
