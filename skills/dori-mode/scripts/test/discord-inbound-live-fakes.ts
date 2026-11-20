import { afterEach } from "bun:test";
import { discordInbound, type DiscordInboundOptions, formatDiscordInbound } from "../src/messenger/discord-inbound.ts";
import type { Emit } from "../src/messenger/discord-inbound-api.ts";
import { type DiscordInboundLive, discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { type DiscordInboundQueue, discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import type { DiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { discordRestWorld, memoryDiscordCursor, type TestDiscordMessage } from "./discord-inbound-fakes.ts";
import { memoryQueue } from "./discord-inbound-memory-queue.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** REST history, per-channel cursors and a fake Gateway socket wired to one live intake. */
const liveWorldWithQueue =
  (createQueue: (dir: string) => DiscordInboundQueue) =>
  async (
    history: TestDiscordMessage[],
    options: DiscordInboundOptions,
    cursors: Record<string, string> = {},
    onEmit?: () => unknown,
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
    const state = withState();
    const queue = createQueue(state.dir);
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
        const record = () => {
          received.push(`${message.channel}:${message.message}`);
          lines.push(formatDiscordInbound(message));
        };
        // An emitter that returns a promise (the --context path) records only once it resolves.
        const pending = onEmit?.();
        if (pending instanceof Promise) return pending.then(record);
        record();
      },
      (line) => logs.push(line),
      queue,
    );
    cleanups.push(async () => {
      live.close();
      await live.done.catch(() => {});
      queue.close();
      state.done();
    });
    live.done.catch(() => {}); // Tests assert on `done` explicitly; this keeps rejections from being unhandled.
    let seq = 0;
    return {
      rest,
      intake,
      queue,
      dir: state.dir,
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

export const liveWorld = liveWorldWithQueue(discordInboundQueue);
export const memoryLiveWorld = liveWorldWithQueue(memoryQueue);

type QueuedScenario = {
  history?: TestDiscordMessage[];
  messages: TestDiscordMessage[];
  cursors?: Record<string, string>;
  admissions?: Record<string, string>;
  parents?: Record<string, string>;
  options?: DiscordInboundOptions;
  sync?: boolean;
  legacy?: boolean;
};

/** Real SQLite close/reopen and atomic cursors; optional faults wrap those same stores, never replace them. */
export const queuedWorld = ({
  history = [],
  messages,
  cursors = { "20": "102" },
  admissions = {},
  parents = {},
  options = { ownerId: "10", channelIds: ["20"] },
  sync = true,
  legacy = false,
}: QueuedScenario) => {
  const state = withState();
  let queue = discordInboundQueue(state.dir);
  for (const [channel, cursor] of Object.entries(cursors)) queue.storeFor(channel).save(cursor);
  if (sync) queue.push("sync");
  for (const message of messages)
    queue.push(
      "message",
      message,
      legacy ? undefined : (admissions[message.id] ?? cursors[message.channel_id]),
      parents[message.channel_id],
    );
  queue.close();
  queue = discordInboundQueue(state.dir);
  const rest = discordRestWorld(history);
  const received: string[] = [];
  const saves: string[] = [];
  let live: DiscordInboundLive | undefined;
  const start = async (
    emit?: Emit,
    storeFor: (channel: string, seed?: boolean) => DiscordInboundStore = queue.storeFor,
  ) => {
    const intake = await discordInbound(
      rest.discord,
      (channel, seed) => {
        const store = storeFor(channel, seed);
        return {
          load: store.load,
          save: (id) => {
            store.save(id);
            saves.push(`${channel}:${id}`);
          },
        };
      },
      options,
    );
    const socket = new FakeGateway("offline");
    live = discordInboundLive(
      intake,
      () => socket,
      "offline",
      gatewayTimers().clock,
      async (message) => {
        await emit?.(message);
        received.push(`${message.channel}:${message.message}`);
      },
      () => {},
      queue,
    );
    const outcome = live.done.then(
      () => undefined,
      (error: unknown) => error,
    );
    return { intake, live, socket, outcome };
  };
  cleanups.push(async () => {
    live?.close();
    await live?.done.catch(() => {});
    queue.close();
    state.done();
  });
  return {
    dir: state.dir,
    rest,
    received,
    saves,
    queue: () => queue,
    cursor: (channel = "20") => queue.storeFor(channel, false).load(),
    start,
    async restart(emit?: Emit, storeFor?: (channel: string, seed?: boolean) => DiscordInboundStore) {
      live?.close();
      await live?.done.catch(() => {});
      queue.close();
      queue = discordInboundQueue(state.dir);
      return await start(emit, storeFor);
    },
  };
};
