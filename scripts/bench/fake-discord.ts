/** An in-process stand-in for the Discord REST endpoints and the Gateway that the intake uses. Offline, token-free. */
import type { ServerWebSocket } from "bun";

export type FakeMessage = {
  id: string;
  channel_id: string;
  type: number;
  author: { id: string };
  content: string;
};

export const OWNER_ID = "100000000000000001";
export const BOT_ID = "100000000000000099";
const ID_BASE = 700_000_000_000_000_000n;

export const startFakeDiscord = (channels: readonly string[]) => {
  const history = new Map<string, FakeMessage[]>(channels.map((id) => [id, []]));
  const postedAt = new Map<string, number>();
  const sockets = new Set<ServerWebSocket<{ auth: boolean }>>();
  let counter = 0n;
  let seq = 0;
  let restRequests = 0;
  let limited = false;

  const rest = (url: URL): Response => {
    restRequests++;
    const path = url.pathname.slice("/api/v10".length);
    if (path === "/users/@me") return Response.json({ id: BOT_ID, bot: true });
    if (path === "/applications/@me") return Response.json({ flags: 1 << 19 });
    const match = /^\/channels\/(\d+)\/messages$/.exec(path);
    const messages = match?.[1] === undefined ? undefined : history.get(match[1]);
    if (!messages) return new Response("{}", { status: 404 });
    if (limited) return Response.json({ retry_after: 1 }, { status: 429, headers: { "Retry-After": "1" } });
    const limit = Number(url.searchParams.get("limit"));
    const before = url.searchParams.get("before");
    const page = messages
      .filter((message) => before === null || BigInt(message.id) < BigInt(before))
      .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
      .slice(0, limit);
    return Response.json(page);
  };

  const server = Bun.serve<{ auth: boolean }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/gateway") {
        return srv.upgrade(request, { data: { auth: false } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      return rest(url);
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 10_000 } }));
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as { op: number };
        if (frame.op === 1) ws.send(JSON.stringify({ op: 11 }));
        else if (frame.op === 2 || frame.op === 6) {
          ws.data.auth = true;
          const ready = frame.op === 2;
          // Like a real session, a RESUME does not replay what was missed here: the REST backfill has to cover it.
          const d = ready ? { session_id: "bench", resume_gateway_url: "wss://bench.discord.gg/" } : {};
          ws.send(JSON.stringify({ op: 0, t: ready ? "READY" : "RESUMED", s: ++seq, d }));
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  return {
    restBase: `http://127.0.0.1:${server.port}/api/v10`,
    gatewayUrl: `ws://127.0.0.1:${server.port}/gateway`,
    /** Posts one message and pushes it to every authenticated Gateway connection. */
    post(channel: string, authorId: string): string {
      const id = String(ID_BASE + ++counter);
      const message: FakeMessage = { id, channel_id: channel, type: 0, author: { id: authorId }, content: "bench" };
      history.get(channel)?.push(message);
      postedAt.set(id, performance.now());
      for (const ws of sockets) {
        if (ws.data.auth) ws.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: ++seq, d: message }));
      }
      return id;
    },
    postedAt,
    authenticated: () => [...sockets].filter((ws) => ws.data.auth).length,
    /** Drops every Gateway connection, as a network failure would. */
    drop: () => {
      for (const ws of sockets) ws.close(4000, "bench drop");
    },
    limit: (on: boolean) => {
      limited = on;
    },
    restRequests: () => restRequests,
    stop: () => server.stop(true),
  };
};
