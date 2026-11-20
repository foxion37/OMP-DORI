// oxlint-disable-next-line import/no-unassigned-import -- a preloaded recorder: importing it installs the Gateway fixtures
import "./record-discord-inbound.ts";

// Real CLI lifecycle, synthetic HTTP/WebSocket events only; no Discord socket is opened.
class FixtureSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.receive({ op: 10, d: { heartbeat_interval: 45_000 } }));
  }
  receive(frame: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  send(raw: string) {
    if (JSON.parse(raw).op !== 2) return;
    queueMicrotask(() => {
      this.receive({
        op: 0,
        t: "READY",
        s: 1,
        d: { session_id: "offline", resume_gateway_url: "wss://gateway.discord.gg" },
      });
      this.receive({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: { id: "103", channel_id: "20", author: { id: "10" }, type: 0, content: "live owner text" },
      });
    });
  }
  close() {}
}
globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
const log = console.log;
console.log = (...args: unknown[]) => {
  log(...args);
  // Stop on the observed delivery, not a guessed wall-clock delay. The next turn allows cursor/queue commit.
  if (process.env["DORI_INBOUND_HOLD"] !== "1" && String(args[0]).startsWith("INBOUND discord 20 103 ")) {
    setImmediate(() => process.kill(process.pid, "SIGTERM"));
  }
};
