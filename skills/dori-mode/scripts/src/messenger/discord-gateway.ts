import type { Clock } from "../run.ts";
import { MessengerError } from "./http.ts";

export type GatewaySocket = {
  send(data: string): void;
  close(code: number): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number) => void): void;
  onError(cb: () => void): void;
};
export type GatewayClock = Pick<Clock, "now"> & {
  random(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
type Payload = {
  op: number;
  s?: number | null;
  t?: string;
  d?: boolean | { heartbeat_interval?: number; session_id?: string; resume_gateway_url?: string };
};
export type GatewayOptions = {
  /** Prefix of the READY/RECONNECT/ACK/STOPPED report lines, e.g. PRESENCE. */
  label: string;
  intents: number;
  /** Identify and resume as online; off leaves the account's presence to whoever else holds a connection. */
  online: boolean;
  onReady?: (event: "READY" | "RESUMED") => void;
  /** Every dispatch other than READY/RESUMED, once the session is established. */
  onDispatch?: (type: string, data: unknown) => void;
};
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const ONLINE = { status: "online", since: null, activities: [], afk: false };
const TERMINAL: Readonly<Record<number, string>> = {
  4004: "authentication failed",
  4010: "invalid shard",
  4011: "sharding required",
  4012: "invalid API version",
  4013: "invalid intents",
  4014: "disallowed intents",
};

export const discordGateway = (
  open: (url: string) => GatewaySocket,
  token: string,
  clock: GatewayClock,
  report: (line: string) => void,
  options: GatewayOptions,
) => {
  const done = Promise.withResolvers<void>();
  let socket: GatewaySocket | undefined;
  let session: { id: string; url: string } | undefined;
  let seq: number | null = null;
  let stopped = false;
  let heartbeat: unknown;
  let handshake: unknown;
  let retry: unknown;
  let readyAt: number | undefined;
  let acknowledged = false;
  let lastIdentify = -Infinity;
  let backoff = 5_000;

  const dispose = (code: number) => {
    const previous = socket;
    socket = undefined;
    if (heartbeat !== undefined) clock.clearTimeout(heartbeat);
    if (handshake !== undefined) clock.clearTimeout(handshake);
    heartbeat = handshake = undefined;
    previous?.close(code);
  };
  const finish = (error?: MessengerError) => {
    stopped = true;
    if (retry !== undefined) clock.clearTimeout(retry);
    retry = undefined;
    dispose(1000);
    if (error) done.reject(error);
    else done.resolve();
  };
  const forget = () => {
    session = undefined;
    seq = null;
  };
  const reconnect = (reason: string, code = 0, requested?: number) => {
    if (stopped || retry !== undefined) return;
    if (acknowledged && readyAt !== undefined && clock.now() - readyAt >= 60_000) {
      backoff = 5_000;
    }
    readyAt = undefined;
    acknowledged = false;
    dispose(4000);
    let delay = requested ?? backoff;
    if (code === 4008) delay = Math.max(delay, 60_000);
    if (!session) delay = Math.max(delay, 5_000 - (clock.now() - lastIdentify));
    backoff = Math.min(backoff * 2, 300_000);
    report(`${options.label}_RECONNECT discord reason=${reason} code=${code} retry_in=${delay / 1000}s`);
    retry = clock.setTimeout(() => {
      retry = undefined;
      connect();
    }, delay);
  };
  const connect = () => {
    if (stopped) return;
    let ws: GatewaySocket;
    try {
      ws = open(session?.url ?? GATEWAY);
    } catch {
      reconnect("connect_error");
      return;
    }
    socket = ws;
    let hello = false;
    let authenticated = false;
    let awaitingAck = false;
    let heartbeatSeq: number | null = null;
    let established = false;
    const current = () => !stopped && socket === ws;
    const send = (frame: unknown) => {
      try {
        ws.send(JSON.stringify(frame));
        return current();
      } catch {
        reconnect("socket_error");
        return false;
      }
    };
    const beat = () => {
      heartbeatSeq = seq;
      if (send({ op: 1, d: heartbeatSeq })) awaitingAck = true;
    };
    const tick = (interval: number) => {
      if (!current()) return;
      if (awaitingAck) return reconnect("heartbeat_timeout");
      beat();
      if (current()) heartbeat = clock.setTimeout(() => tick(interval), interval);
    };
    handshake = clock.setTimeout(() => reconnect("handshake_timeout"), 30_000);
    ws.onClose((code) => {
      if (!current()) return;
      const terminal = TERMINAL[code];
      if (terminal) return finish(new MessengerError(`Discord gateway closed code=${code} (${terminal})`, code));
      if (code === 1000 || code === 1001 || code === 4007 || code === 4009) forget();
      reconnect("closed", code);
    });
    ws.onError(() => {
      if (current()) reconnect("socket_error");
    });
    ws.onMessage((raw) => {
      if (!current()) return;
      let m: Payload;
      try {
        m = JSON.parse(raw) as Payload;
        if (!m || typeof m !== "object" || typeof m.op !== "number") throw new Error();
      } catch {
        reconnect("invalid_payload");
        return;
      }
      if (m.op === 0 && typeof m.s === "number") seq = m.s;
      if (m.op === 10) {
        const interval = m.d && typeof m.d === "object" ? m.d.heartbeat_interval : undefined;
        if (hello || typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
          reconnect("invalid_hello");
          return;
        }
        hello = true;
        heartbeat = clock.setTimeout(() => tick(interval), clock.random() * interval);
        authenticated = send(
          session && seq !== null
            ? { op: 6, d: { token, session_id: session.id, seq } }
            : {
                op: 2,
                d: {
                  token,
                  intents: options.intents,
                  properties: { os: process.platform, browser: "dori", device: "dori" },
                  ...(options.online ? { presence: ONLINE } : {}),
                },
              },
        );
        if (!session && authenticated) lastIdentify = clock.now();
      } else if (m.op === 11 && awaitingAck) {
        awaitingAck = false;
        if (!acknowledged) {
          acknowledged = true;
          report(`${options.label}_ACK discord seq=${heartbeatSeq ?? "-"}`);
        }
      } else if (m.op === 1 && hello) {
        beat();
      } else if (m.op === 7) {
        reconnect("server_reconnect", 0, 0);
      } else if (m.op === 9) {
        if (m.d !== true) forget();
        reconnect("invalid_session", 0, 1_000 + Math.floor(clock.random() * 4_000));
      } else if (m.op === 0 && (m.t === "READY" || m.t === "RESUMED")) {
        if (!hello || !authenticated || seq === null) return reconnect("invalid_session_dispatch");
        if (m.t === "READY") {
          try {
            if (!m.d || typeof m.d !== "object" || !m.d.session_id || !m.d.resume_gateway_url) throw new Error();
            const url = new URL(m.d.resume_gateway_url);
            if (url.protocol !== "wss:" || !url.hostname.endsWith(".discord.gg") || url.username || url.password) {
              throw new Error();
            }
            url.search = "?v=10&encoding=json";
            session = { id: m.d.session_id, url: url.href };
          } catch {
            reconnect("invalid_session_dispatch");
            return;
          }
        } else if (!session || (options.online && !send({ op: 3, d: ONLINE }))) {
          return;
        }
        if (handshake !== undefined) clock.clearTimeout(handshake);
        handshake = undefined;
        readyAt = clock.now();
        report(`${options.label}_READY discord event=${m.t}`);
        established = true;
        options.onReady?.(m.t);
      } else if (m.op === 0 && established && typeof m.t === "string") {
        options.onDispatch?.(m.t, m.d);
      }
    });
  };
  connect();
  return {
    done: done.promise,
    close() {
      if (stopped) return;
      finish();
      report(`${options.label}_STOPPED discord`);
    },
  };
};
