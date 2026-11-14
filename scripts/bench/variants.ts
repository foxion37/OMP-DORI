/** The intake implementations under test, each driven through its real code path against a fake Discord. */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Discord } from "../../skills/dori-mode/scripts/src/messenger/discord.ts";
import { discordInbound } from "../../skills/dori-mode/scripts/src/messenger/discord-inbound.ts";
import { discordInboundLive } from "../../skills/dori-mode/scripts/src/messenger/discord-inbound-live.ts";
import type { DiscordInboundStore } from "../../skills/dori-mode/scripts/src/messenger/discord-inbound-state.ts";
import { fetchHttp } from "../../skills/dori-mode/scripts/src/messenger/http.ts";
import { realClock } from "../../skills/dori-mode/scripts/src/run.ts";
import { OWNER_ID, type startFakeDiscord } from "./fake-discord.ts";

export type Emit = { channel: string; message: string; at: number };
export type Fake = ReturnType<typeof startFakeDiscord>;
export type Instance = { stop(): Promise<void> };
export type Variant = {
  name: string;
  /** Channels this implementation can watch out of the scenario's channels. */
  start(fake: Fake, channels: readonly string[], pollMs: number, emit: (e: Emit) => void): Promise<Instance>;
};

const memoryStore = (): DiscordInboundStore => {
  let cursor: string | undefined;
  return { load: () => cursor, save: (value) => (cursor = value) };
};
const discordFor = (fake: Fake) => new Discord(fetchHttp, realClock, "bench-token", fake.restBase);
const record = (emit: (e: Emit) => void) => (message: { channel: string; message: string }) =>
  emit({ channel: message.channel, message: message.message, at: performance.now() });

/** Calls `poll` every `ms` after the previous one finishes, like `dori inbound discord` does; failures are logged only. */
const loop = (poll: () => Promise<void>, ms: number): Instance => {
  let running = true;
  const done = (async () => {
    while (running) {
      await poll().catch(() => {});
      const until = performance.now() + ms;
      while (running && performance.now() < until) await Bun.sleep(Math.min(50, until - performance.now()));
    }
  })();
  return {
    async stop() {
      running = false;
      await done;
    },
  };
};

type BaselineModule = {
  discordInbound(
    discord: Discord,
    store: DiscordInboundStore,
    opts: { ownerId: string; channelId: string },
  ): Promise<{ poll(emit: (message: { channel: string; message: string }) => void): Promise<void> }>;
};

/** Loads the intake of an earlier commit unchanged; its sibling imports resolve to this checkout's unchanged modules. */
export const loadBaseline = async (source: string): Promise<BaselineModule> => {
  const dir = resolve(import.meta.dir, "../../skills/dori-mode/scripts/src/messenger");
  const rewritten = source.replace(/from "\.\/([\w-]+\.ts)"/g, (_, file: string) => `from "${join(dir, file)}"`);
  const out = join(tmpdir(), `dori-bench-baseline-${process.pid}`);
  mkdirSync(out, { recursive: true });
  const path = join(out, "discord-inbound-baseline.ts");
  writeFileSync(path, rewritten);
  return (await import(path)) as BaselineModule;
};

const restMulti = (name: string, instancePerChannel: boolean, baseline?: BaselineModule): Variant => ({
  name,
  async start(fake, channels, pollMs, emit) {
    const send = record(emit);
    const polls: (() => Promise<void>)[] = [];
    if (baseline) {
      const watched = instancePerChannel ? channels : channels.slice(0, 1);
      for (const channelId of watched) {
        const intake = await baseline.discordInbound(discordFor(fake), memoryStore(), { ownerId: OWNER_ID, channelId });
        polls.push(() => intake.poll(send));
      }
    } else {
      const stores = new Map<string, DiscordInboundStore>();
      const storeFor = (id: string) => stores.get(id) ?? stores.set(id, memoryStore()).get(id)!;
      const intake = await discordInbound(discordFor(fake), storeFor, { ownerId: OWNER_ID, channelIds: channels });
      polls.push(() => intake.poll(send));
    }
    return loop(async () => {
      await Promise.all(polls.map((poll) => poll()));
    }, pollMs);
  },
});

const gateway: Variant = {
  name: "gateway",
  async start(fake, channels, _pollMs, emit) {
    const stores = new Map<string, DiscordInboundStore>();
    const storeFor = (id: string) => stores.get(id) ?? stores.set(id, memoryStore()).get(id)!;
    const intake = await discordInbound(discordFor(fake), storeFor, { ownerId: OWNER_ID, channelIds: channels });
    const live = discordInboundLive(
      intake,
      () => {
        const ws = new WebSocket(fake.gatewayUrl);
        return {
          send: (data) => ws.send(data),
          close: (code) => ws.close(code),
          onMessage: (cb) => ws.addEventListener("message", (event) => cb(String(event.data))),
          onClose: (cb) => ws.addEventListener("close", (event) => cb(event.code)),
          onError: (cb) => ws.addEventListener("error", () => cb()),
        };
      },
      "bench-token",
      {
        now: realClock.now,
        random: Math.random,
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      record(emit),
      () => {},
    );
    live.done.catch(() => {});
    return {
      async stop() {
        live.close();
        await live.done;
      },
    };
  },
};

export const variantsFor = (baseline: BaselineModule): Variant[] => [
  restMulti("baseline (single channel)", false, baseline),
  restMulti("baseline x N", true, baseline),
  restMulti("rest, N channels", false),
  gateway,
];
