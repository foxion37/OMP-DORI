// Preloaded by messenger-reconnect.test.ts; all Gateway events and elapsed time are controlled locally.
const pending = new Map<number, { at: number; cb: () => void }>();
const sockets: Gateway[] = [];
let now = 0;
let timerId = 0;
let identified = 0;
let resumed = 0;
let presenceUpdates = 0;
let heartbeats = 0;
const scenario = process.env["GATEWAY_CASE"];
type GatewayEvent = { readonly data?: string; readonly code?: number };

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
const stopped = (signal: "SIGINT" | "SIGTERM") => {
  process.emit(signal);
  console.log(
    `GATEWAY_QA ${JSON.stringify({
      opened: sockets.length,
      active: sockets.filter((socket) => !socket.closed).length,
      timers: pending.size,
      identified,
      resumed,
      presenceUpdates,
      heartbeats,
    })}`,
  );
};

class Gateway {
  readonly listeners = new Map<string, Array<(event: GatewayEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    if (sockets.some((socket) => !socket.closed)) throw new Error("overlapping Gateway sockets");
    sockets.push(this);
    queueMicrotask(() => {
      this.message({ op: 10, d: { heartbeat_interval: 10_000 } });
      if (scenario === "terminal") {
        this.close(4014);
        return;
      }
      if (sockets[0] === this) {
        this.message({
          op: 0,
          t: "READY",
          s: 3,
          d: { session_id: "session", resume_gateway_url: "wss://resume.discord.gg/" },
        });
        if (scenario === "stop-backoff") {
          this.close(1006);
          stopped("SIGTERM");
          return;
        }
        advance(5_000);
        this.message({ op: 11 });
        this.message({ op: 7 });
        advance(0);
        if (sockets.length !== 2) throw new Error("server reconnect did not open a replacement");
      } else {
        if (url !== "wss://resume.discord.gg/?v=10&encoding=json") throw new Error("resume URL was lost");
        this.message({ op: 0, t: "RESUMED", s: 4, d: {} });
        advance(5_000);
        this.message({ op: 11 });
        stopped("SIGINT");
      }
    });
  }

  addEventListener(type: string, listener: (event: GatewayEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  message(frame: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(frame) });
  }
  send(data: string): void {
    if (this.closed) throw new Error("sending on a retired socket");
    const frame = JSON.parse(data) as {
      op: number;
      d:
        | number
        | { token?: string; session_id?: string; seq?: number; presence?: { status?: string }; status?: string };
    };
    if (frame.op === 1) {
      if (frame.d !== (sockets.length === 1 ? 3 : 4)) throw new Error("heartbeat lost its sequence");
      heartbeats++;
    } else if (typeof frame.d === "object") {
      if (frame.op === 2 && frame.d.presence?.status === "online") identified++;
      else if (frame.op === 6 && frame.d.session_id === "session" && frame.d.seq === 3) resumed++;
      else if (frame.op === 3 && frame.d.status === "online") presenceUpdates++;
      else throw new Error("unexpected Gateway authentication or presence frame");
      if ((frame.op === 2 || frame.op === 6) && frame.d.token !== process.env["DORI_DISCORD_TOKEN"]) {
        throw new Error("Gateway authentication used the wrong credential reference");
      }
    } else throw new Error("unexpected Gateway frame");
  }
  close(code: number): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners.get("close") ?? []) listener({ code });
  }
}

Object.defineProperty(globalThis, "WebSocket", { value: Gateway });
Object.defineProperty(globalThis, "fetch", {
  value: () => {
    throw new Error("network access is disabled in the Gateway fixture");
  },
});
Object.defineProperty(globalThis, "setTimeout", {
  value: (cb: () => void, ms: number) => {
    pending.set(++timerId, { at: now + ms, cb });
    return timerId;
  },
});
Object.defineProperty(globalThis, "clearTimeout", {
  value: (handle: number) => {
    pending.delete(handle);
  },
});
Date.now = () => now;
Math.random = () => 0.5;
