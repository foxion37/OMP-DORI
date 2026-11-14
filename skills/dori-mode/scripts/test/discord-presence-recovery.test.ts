import { expect, test } from "bun:test";
import { MessengerError } from "../src/messenger/http.ts";
import { gatewayWorld } from "./discord-presence-fakes.ts";

test("invalid sessions honor the retry delay and resumability, including identify's five second window", async () => {
  for (const resumable of [true, false]) {
    const f = gatewayWorld();
    const old = f.sockets[0]!;
    old.hello();
    old.ready();
    old.receive({ op: 9, d: resumable });
    const wait = resumable ? 3_000 : 5_000;
    expect(f.logs.at(-1)).toBe(`PRESENCE_RECONNECT discord reason=invalid_session code=0 retry_in=${wait / 1000}s`);
    expect(old.closed).toBe(true);
    expect(f.pending.size).toBe(1);
    f.advance(wait - 1);
    expect(f.sockets).toHaveLength(1);
    f.advance(1);
    const next = f.sockets[1]!;
    next.hello();
    expect(next.url).toBe(`wss://${resumable ? "resume" : "gateway"}.discord.gg/?v=10&encoding=json`);
    if (resumable) {
      expect(next.frames[0]).toEqual({ op: 6, d: { token: "private-bot-token", session_id: "session", seq: 3 } });
    } else {
      expect(next.frames[0]).toMatchObject({ op: 2, d: { presence: { status: "online" } } });
    }
    f.presence.close();
    await f.presence.done;
    expect(f.pending.size).toBe(0);
  }
});

test("invalid sequence, expired session, and normal close codes start a fresh session", async () => {
  for (const code of [1000, 1001, 4007, 4009]) {
    const f = gatewayWorld();
    const old = f.sockets[0]!;
    old.hello();
    old.ready();
    old.disconnect(code);
    f.advance(5_000);
    const next = f.sockets[1]!;
    expect(next.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    next.hello();
    expect(next.frames[0]).toMatchObject({ op: 2, d: { presence: { status: "online" } } });
    f.presence.close();
    await f.presence.done;
    expect(f.pending.size).toBe(0);
  }
});

test("terminal authentication and configuration errors reject once without reconnecting or disclosing diagnostics", async () => {
  for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
    const f = gatewayWorld();
    const old = f.sockets[0]!;
    old.hello();
    old.ready();
    const failure = f.presence.done.catch((error: unknown) => error);
    old.disconnect(code);
    const error = await failure;
    expect(error).toBeInstanceOf(MessengerError);
    expect((error as Error).message).toStartWith(`Discord gateway closed code=${code} (`);
    expect((error as MessengerError).status).toBe(code);
    f.presence.close();
    old.error();
    old.disconnect(1006);
    f.advance(600_000);
    expect(f.sockets).toHaveLength(1);
    expect(f.pending.size).toBe(0);
    expect(f.logs.filter((line) => line.startsWith("PRESENCE_RECONNECT"))).toEqual([]);
    expect(`${(error as Error).message}\n${f.logs.join("\n")}`).not.toMatch(/private|token|diagnostic/);
  }
});

test("connection failures back off to a fixed ceiling and stop cancels the retry", async () => {
  const f = gatewayWorld(8);
  const delays = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000];
  for (const delay of delays) f.advance(delay);
  expect(f.logs).toEqual(
    delays.map((delay) => `PRESENCE_RECONNECT discord reason=connect_error code=0 retry_in=${delay / 1000}s`),
  );
  expect(f.sockets).toHaveLength(1);
  expect(f.pending.size).toBe(1);
  f.presence.close();
  await f.presence.done;
  expect(f.pending.size).toBe(0);
});

test("only an authenticated healthy minute resets reconnect backoff", async () => {
  const f = gatewayWorld();
  f.sockets[0]!.disconnect(1006);
  f.advance(5_000);
  const next = f.sockets[1]!;
  next.hello();
  next.ready();
  f.advance(5_000);
  next.receive({ op: 11 });
  for (let i = 0; i < 6; i++) {
    f.advance(10_000);
    next.receive({ op: 11 });
  }
  next.disconnect(1006);
  expect(f.logs.at(-1)).toBe("PRESENCE_RECONNECT discord reason=closed code=1006 retry_in=5s");
  f.presence.close();
  await f.presence.done;
  expect(f.pending.size).toBe(0);
});

test("Gateway rate limiting waits out the event window before resuming", async () => {
  const f = gatewayWorld();
  const old = f.sockets[0]!;
  old.hello();
  old.ready();
  old.disconnect(4008);
  expect(f.logs.at(-1)).toBe("PRESENCE_RECONNECT discord reason=closed code=4008 retry_in=60s");
  f.advance(59_999);
  expect(f.sockets).toHaveLength(1);
  f.advance(1);
  f.sockets[1]!.hello();
  expect(f.sockets[1]!.frames[0]).toMatchObject({ op: 6 });
  f.presence.close();
  await f.presence.done;
  expect(f.pending.size).toBe(0);
});

test("both a silent connection and HELLO without READY time out without announcing readiness", async () => {
  for (const hello of [false, true]) {
    const f = gatewayWorld();
    const old = f.sockets[0]!;
    if (hello) old.hello(120_000);
    f.advance(30_000);
    expect(old.closed).toBe(true);
    expect(f.pending.size).toBe(1);
    expect(f.logs).toEqual(["PRESENCE_RECONNECT discord reason=handshake_timeout code=0 retry_in=5s"]);
    f.presence.close();
    await f.presence.done;
    expect(f.pending.size).toBe(0);
  }
});

test("transport errors and failed sends retire the current socket without leaking heartbeat timers", async () => {
  for (const failedSend of [false, true]) {
    const f = gatewayWorld();
    const old = f.sockets[0]!;
    old.hello();
    old.ready();
    if (failedSend) {
      old.failSend = true;
      f.advance(5_000);
    } else {
      old.error();
    }
    expect(old.closed).toBe(true);
    expect(f.pending.size).toBe(1);
    expect(f.logs.at(-1)).toBe("PRESENCE_RECONNECT discord reason=socket_error code=0 retry_in=5s");
    expect(f.logs.join("\n")).not.toMatch(/private|token|diagnostic/);
    f.presence.close();
    await f.presence.done;
    expect(f.pending.size).toBe(0);
  }
});

test("malformed Gateway data is discarded without leaking the raw payload", async () => {
  const f = gatewayWorld();
  const old = f.sockets[0]!;
  old.message("private gateway body is not JSON");
  expect(old.closed).toBe(true);
  expect(f.logs).toEqual(["PRESENCE_RECONNECT discord reason=invalid_payload code=0 retry_in=5s"]);
  expect(f.pending.size).toBe(1);
  f.presence.close();
  await f.presence.done;
  expect(f.pending.size).toBe(0);
});

test("repeated server reconnect and resumable invalid-session instructions retain their protocol delays", async () => {
  const f = gatewayWorld();
  f.sockets[0]!.hello();
  f.sockets[0]!.ready();
  for (const seq of [4, 5]) {
    f.sockets.at(-1)!.receive({ op: 7 });
    expect(f.logs.at(-1)).toBe("PRESENCE_RECONNECT discord reason=server_reconnect code=0 retry_in=0s");
    const count = f.sockets.length;
    f.advance(0);
    expect(f.sockets).toHaveLength(count + 1);
    f.sockets.at(-1)!.hello();
    f.sockets.at(-1)!.receive({ op: 0, t: "RESUMED", s: seq, d: {} });
  }
  for (const seq of [6, 7]) {
    f.sockets.at(-1)!.receive({ op: 9, d: true });
    expect(f.logs.at(-1)).toBe("PRESENCE_RECONNECT discord reason=invalid_session code=0 retry_in=3s");
    const count = f.sockets.length;
    f.advance(2_999);
    expect(f.sockets).toHaveLength(count);
    f.advance(1);
    expect(f.sockets).toHaveLength(count + 1);
    const next = f.sockets.at(-1)!;
    next.hello();
    expect(next.frames[0]).toMatchObject({ op: 6, d: { seq: seq - 1 } });
    next.receive({ op: 0, t: "RESUMED", s: seq, d: {} });
  }
  f.presence.close();
  await f.presence.done;
  expect(f.pending.size).toBe(0);
});

test("uptime without a heartbeat ACK never resets failed-connection backoff", async () => {
  const f = gatewayWorld(1);
  f.advance(5_000);
  const socket = f.sockets[0]!;
  socket.hello(120_000);
  socket.ready();
  f.advance(180_000);
  expect(socket.closed).toBe(true);
  expect(f.logs.at(-1)).toBe("PRESENCE_RECONNECT discord reason=heartbeat_timeout code=0 retry_in=10s");
  expect(f.pending.size).toBe(1);
  f.presence.close();
  await f.presence.done;
  expect(f.pending.size).toBe(0);
});
