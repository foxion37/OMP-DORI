import { expect, test } from "bun:test";
import { gatewayWorld } from "./discord-presence-fakes.ts";

test("Discord announces readiness only after READY, identifies online, and acknowledges sequenced heartbeats", async () => {
  const f = gatewayWorld();
  const socket = f.sockets[0]!;
  expect(f.logs).toEqual([]);
  socket.hello();
  expect(socket.frames).toEqual([
    {
      op: 2,
      d: {
        token: "private-bot-token",
        intents: 512,
        properties: { os: process.platform, browser: "dori", device: "dori" },
        presence: { status: "online", since: null, activities: [], afk: false },
      },
    },
  ]);
  expect(f.logs).toEqual([]);
  socket.receive({ op: 11 });
  expect(f.logs).toEqual([]);
  socket.ready();
  expect(f.logs).toEqual(["PRESENCE_READY discord event=READY"]);
  expect(f.pending.size).toBe(1);
  f.advance(4_999);
  expect(socket.frames).toHaveLength(1);
  f.advance(1);
  expect(socket.frames.at(-1)).toEqual({ op: 1, d: 3 });
  socket.receive({ op: 0, s: 8, t: "MESSAGE_CREATE", d: { content: "private gateway content" } });
  socket.receive({ op: 11 });
  expect(f.logs.at(-1)).toBe("PRESENCE_ACK discord seq=3");
  socket.receive({ op: 1 });
  expect(socket.frames.at(-1)).toEqual({ op: 1, d: 8 });
  socket.receive({ op: 11 });
  f.advance(10_000);
  expect(socket.frames.at(-1)).toEqual({ op: 1, d: 8 });
  socket.receive({ op: 11 });
  f.presence.close();
  await f.presence.done;
  expect(socket.closes).toEqual([1000]);
  expect(f.pending.size).toBe(0);
  expect(f.logs.at(-1)).toBe("PRESENCE_STOPPED discord");
  expect(f.logs.filter((line) => line.startsWith("PRESENCE_ACK"))).toEqual(["PRESENCE_ACK discord seq=3"]);
  expect(f.logs.join("\n")).not.toMatch(/private|token|content/);
});

test("a missing ACK retires the socket and timers, resumes the session, and restores online presence", async () => {
  const f = gatewayWorld();
  const old = f.sockets[0]!;
  old.hello();
  old.ready();
  f.advance(5_000);
  expect(old.frames.at(-1)).toEqual({ op: 1, d: 3 });
  f.advance(10_000);
  expect(old.closes).toEqual([4000]);
  expect(f.pending.size).toBe(1);
  expect(f.logs.at(-1)).toBe("PRESENCE_RECONNECT discord reason=heartbeat_timeout code=0 retry_in=5s");
  old.receive({ op: 11 });
  old.disconnect(1006);
  old.error();
  old.ready(999);
  f.advance(5_000);
  expect(f.sockets).toHaveLength(2);
  const resumed = f.sockets[1]!;
  expect(resumed.url).toBe("wss://resume.discord.gg/?v=10&encoding=json");
  resumed.hello();
  expect(resumed.frames).toEqual([{ op: 6, d: { token: "private-bot-token", session_id: "session", seq: 3 } }]);
  expect(f.logs.filter((line) => line.startsWith("PRESENCE_READY"))).toHaveLength(1);
  resumed.receive({ op: 0, s: 4, t: "RESUMED", d: {} });
  expect(resumed.frames.at(-1)).toEqual({
    op: 3,
    d: { status: "online", since: null, activities: [], afk: false },
  });
  expect(f.logs.at(-1)).toBe("PRESENCE_READY discord event=RESUMED");
  expect(f.pending.size).toBe(1);
  f.advance(5_000);
  resumed.receive({ op: 11 });
  expect(f.logs.at(-1)).toBe("PRESENCE_ACK discord seq=4");
  f.presence.close();
  await f.presence.done;
  expect(f.pending.size).toBe(0);
});

test("a server reconnect immediately resumes without another identify or overlapping heartbeat", async () => {
  const f = gatewayWorld();
  const old = f.sockets[0]!;
  old.hello();
  old.ready(10);
  old.receive({ op: 7 });
  expect(old.closed).toBe(true);
  expect(f.pending.size).toBe(1);
  expect(f.logs.at(-1)).toBe("PRESENCE_RECONNECT discord reason=server_reconnect code=0 retry_in=0s");
  f.advance(0);
  const next = f.sockets[1]!;
  old.receive({ op: 10, d: { heartbeat_interval: 1 } });
  next.hello();
  expect(next.frames[0]).toEqual({ op: 6, d: { token: "private-bot-token", session_id: "session", seq: 10 } });
  next.receive({ op: 0, t: "RESUMED", s: 11, d: {} });
  expect(f.pending.size).toBe(1);
  f.presence.close();
  f.presence.close();
  next.disconnect(1006);
  next.receive({ op: 7 });
  f.advance(600_000);
  await f.presence.done;
  expect(next.closes).toEqual([1000]);
  expect(f.sockets).toHaveLength(2);
  expect(f.pending.size).toBe(0);
  expect(f.logs.filter((line) => line === "PRESENCE_STOPPED discord")).toHaveLength(1);
});

test("explicit stop during handshake or reconnect cancels all future work", async () => {
  for (const duringRetry of [false, true]) {
    const f = gatewayWorld();
    const old = f.sockets[0]!;
    if (duringRetry) old.disconnect(1006);
    f.presence.close();
    old.hello();
    old.ready();
    old.error();
    f.advance(600_000);
    await f.presence.done;
    expect(f.sockets).toHaveLength(1);
    expect(f.pending.size).toBe(0);
    expect(f.logs.some((line) => line.startsWith("PRESENCE_READY"))).toBe(false);
    expect(f.logs.at(-1)).toBe("PRESENCE_STOPPED discord");
  }
});

test("a duplicate HELLO retires the existing heartbeat rather than leaking a second timer", async () => {
  const f = gatewayWorld();
  const old = f.sockets[0]!;
  old.hello();
  expect(f.pending.size).toBe(2);
  old.hello();
  expect(old.closed).toBe(true);
  expect(old.frames).toHaveLength(1);
  expect(f.pending.size).toBe(1);
  expect(f.logs.at(-1)).toBe("PRESENCE_RECONNECT discord reason=invalid_hello code=0 retry_in=5s");
  f.presence.close();
  await f.presence.done;
  expect(f.pending.size).toBe(0);
});
