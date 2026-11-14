import { discordInbound, type DiscordInboundOptions, formatDiscordInbound } from "../src/messenger/discord-inbound.ts";
import { discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { discordRestWorld, memoryDiscordCursor, type TestDiscordMessage } from "./discord-inbound-fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** REST history, per-channel cursors and a fake Gateway socket wired to one live intake. */
export const liveWorld = async (
  history: TestDiscordMessage[],
  options: DiscordInboundOptions,
  cursors: Record<string, string> = {},
  onEmit?: () => void,
) => {
  const rest = discordRestWorld(history);
  const stores = new Map<string, ReturnType<typeof memoryDiscordCursor>>();
  const store = (channel: string) => {
    const entry = stores.get(channel) ?? memoryDiscordCursor(cursors[channel]);
    stores.set(channel, entry);
    return entry.store;
  };
  const intake = await discordInbound(rest.discord, store, options);
  const timers = gatewayTimers();
  const sockets: FakeGateway[] = [];
  const logs: string[] = [];
  const received: string[] = [];
  const lines: string[] = [];
  const live = discordInboundLive(
    intake,
    (url) => {
      const socket = new FakeGateway(url);
      sockets.push(socket);
      return socket;
    },
    "unit-private-token",
    timers.clock,
    (message) => {
      onEmit?.();
      received.push(`${message.channel}:${message.message}`);
      lines.push(formatDiscordInbound(message));
    },
    (line) => logs.push(line),
  );
  live.done.catch(() => {}); // Tests assert on `done` explicitly; this keeps rejections from being unhandled.
  let seq = 0;
  return {
    rest,
    intake,
    live,
    sockets,
    logs,
    received,
    lines,
    advance: timers.advance,
    pending: timers.pending,
    cursor: (channel: string) => store(channel).load(),
    /** Completes the Gateway handshake as READY (first connection) or RESUMED (resume). */
    async connect(socket: FakeGateway, resumed = false) {
      socket.hello();
      if (resumed) socket.receive({ op: 0, t: "RESUMED", s: ++seq, d: {} });
      else {
        seq = 1;
        socket.ready(seq);
      }
      await settle();
    },
    async dispatch(socket: FakeGateway, message: TestDiscordMessage) {
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: ++seq, d: message });
      await settle();
    },
  };
};
