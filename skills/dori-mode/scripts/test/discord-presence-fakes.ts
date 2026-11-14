import type { GatewayClock, GatewaySocket } from "../src/messenger/discord-gateway.ts";
import { discordPresence } from "../src/messenger/discord-presence.ts";

type Frame = { op: number; d: unknown };
export class FakeGateway implements GatewaySocket {
  readonly frames: Frame[] = [];
  readonly closes: number[] = [];
  closed = false;
  failSend = false;
  message: (raw: string) => void = () => {};
  disconnect: (code: number) => void = () => {};
  error: () => void = () => {};

  constructor(readonly url: string) {}

  send(data: string) {
    if (this.closed || this.failSend) throw new Error("transport failure with private diagnostic");
    this.frames.push(JSON.parse(data) as Frame);
  }
  close(code: number) {
    this.closed = true;
    this.closes.push(code);
    this.disconnect(code);
  }
  onMessage(cb: (data: string) => void) {
    this.message = cb;
  }
  onClose(cb: (code: number) => void) {
    this.disconnect = cb;
  }
  onError(cb: () => void) {
    this.error = cb;
  }
  receive(frame: unknown) {
    this.message(JSON.stringify(frame));
  }
  hello(interval = 10_000) {
    this.receive({ op: 10, d: { heartbeat_interval: interval } });
  }
  ready(seq = 3) {
    this.receive({
      op: 0,
      t: "READY",
      s: seq,
      d: { session_id: "session", resume_gateway_url: "wss://resume.discord.gg/" },
    });
  }
}

/** A manual clock: timers fire only when `advance` reaches them. */
export const gatewayTimers = () => {
  let now = 0;
  let id = 0;
  const pending = new Map<number, { at: number; cb: () => void }>();
  const clock: GatewayClock = {
    now: () => now,
    random: () => 0.5,
    setTimeout: (cb, ms) => {
      pending.set(++id, { at: now + ms, cb });
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const next = [...pending].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > target) break;
      now = next[1].at;
      pending.delete(next[0]);
      next[1].cb();
    }
    now = target;
  };
  return { clock, pending, advance };
};

export const gatewayWorld = (openFailures = 0) => {
  const { clock, pending, advance } = gatewayTimers();
  const sockets: FakeGateway[] = [];
  const logs: string[] = [];
  const presence = discordPresence(
    (url) => {
      if (sockets.some((socket) => !socket.closed)) throw new Error("overlapping gateway sockets");
      if (openFailures-- > 0) throw new Error("private connection diagnostic");
      const socket = new FakeGateway(url);
      sockets.push(socket);
      return socket;
    },
    "private-bot-token",
    clock,
    (line) => logs.push(line),
  );
  return { presence, sockets, logs, pending, advance };
};
