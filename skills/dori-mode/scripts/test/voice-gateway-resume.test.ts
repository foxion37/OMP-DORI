import { expect, test } from "bun:test";
import { discordGateway } from "../src/messenger/discord-gateway.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { HEARTBEAT, ids, readyWorld } from "./voice-discord-fakes.ts";

const state = (userId: string, channelId: string | null, guildId: string = ids.guild) => ({
  guild_id: guildId,
  user_id: userId,
  channel_id: channelId,
  session_id: "voice-session",
});
const resume = (w: { socket(): FakeGateway; advance(ms: number): void }) => {
  const retired = w.socket();
  retired.receive({ op: 7 });
  w.advance(0);
  w.socket().hello(HEARTBEAT);
  expect(w.socket().frames[0]).toMatchObject({ op: 6, d: { session_id: "session" } });
  return retired;
};

test.each([false, true])("Gateway resume replay is authenticated, ordered and opt-in (%s)", async (replay) => {
  const { clock, advance, pending } = gatewayTimers();
  const sockets: FakeGateway[] = [];
  const seen: string[] = [];
  const gateway = discordGateway(
    (url) => {
      const socket = new FakeGateway(url);
      sockets.push(socket);
      return socket;
    },
    "fake-token",
    clock,
    () => {},
    {
      label: "TEST",
      intents: 0,
      online: false,
      ...(replay ? { replayDispatches: true } : {}),
      onDispatch: (type) => seen.push(type),
    },
  );
  const first = sockets[0]!;
  first.hello(HEARTBEAT);
  first.receive({ op: 0, s: 1, t: "BEFORE_READY", d: {} });
  first.ready(2);
  first.receive({ op: 0, s: 3, t: "LIVE", d: {} });
  first.receive({ op: 7 });
  advance(0);
  const second = sockets[1]!;
  second.receive({ op: 0, t: "BEFORE_HELLO", d: {} });
  second.hello(HEARTBEAT);
  expect(second.frames[0]).toMatchObject({ op: 6, d: { seq: 3 } });
  expect(gateway.send({ op: 4, d: {} })).toBe(false);
  second.receive({ op: 0, s: 4, t: "REPLAY_ONE", d: {} });
  second.receive({ op: 0, s: 5, t: "REPLAY_TWO", d: {} });
  expect(seen).toEqual(replay ? ["LIVE", "REPLAY_ONE", "REPLAY_TWO"] : ["LIVE"]);
  second.receive({ op: 0, s: 6, t: "RESUMED", d: {} });
  expect(gateway.send({ op: 4, d: {} })).toBe(true);
  second.receive({ op: 0, s: 7, t: "AFTER_RESUMED", d: {} });
  expect(seen).toEqual(replay ? ["LIVE", "REPLAY_ONE", "REPLAY_TWO", "AFTER_RESUMED"] : ["LIVE", "AFTER_RESUMED"]);
  gateway.close();
  await gateway.done;
  expect(pending.size).toBe(0);
});

test("a Gateway gap revokes voice admission and playback until replay completes", async () => {
  const w = readyWorld();
  const link = w.link();
  const oldStream = link.streams[0]!;
  const generation = w.playback.generation;
  const oldSource = w.driver.source!;
  w.playback.write(Buffer.alloc(48_000));
  expect(w.playback.queuedMs()).toBe(1000);
  w.socket().receive({ op: 7 });
  expect(w.presence).toEqual([true, false]);
  expect(oldStream.destroyed).toBe(true);
  expect(w.playback.audible).toBe(false);
  expect(w.playback.queuedMs()).toBe(0);
  expect(oldSource.destroyed).toBe(true);
  expect(w.playback.generation).toBeGreaterThan(generation);
  oldStream.push(Buffer.from([1]));
  w.playback.write(Buffer.alloc(48_000));
  link.move("connecting");
  link.move("ready");
  expect(w.pcm).toEqual([]);
  expect(w.presence).toEqual([true, false]);
  expect(w.playback.queuedMs()).toBe(0);
  w.advance(0);
  w.socket().hello(HEARTBEAT);
  expect(w.playback.audible).toBe(false);
  w.dispatch("RESUMED", {});
  expect(w.presence).toEqual([true, false, true]);
  expect(w.playback.audible).toBe(true);
  expect(w.driver.source).not.toBe(oldSource);
  expect(w.driver.links).toEqual([link]);
  link.streams.at(-1)!.push(Buffer.from([2]));
  expect(w.pcm.map((chunk) => chunk[0])).toEqual([2]);
  w.voice.close();
  await w.voice.done;
  expect(w.pending.size).toBe(0);
});

test.each([null, ids.elsewhere])("replayed owner departure to %s prevents stale admission", async (channel) => {
  const w = readyWorld();
  const oldStream = w.link().streams[0]!;
  resume(w);
  w.dispatch("VOICE_STATE_UPDATE", state(ids.owner, channel));
  w.dispatch("RESUMED", {});
  expect(w.presence.at(-1)).toBe(false);
  expect(w.link().subscribed(ids.owner)).toBe(false);
  oldStream.push(Buffer.from([3]));
  w.link().move("connecting");
  w.link().move("ready");
  expect(w.pcm).toEqual([]);
  expect(w.presence.at(-1)).toBe(false);
  w.dispatch("VOICE_STATE_UPDATE", state(ids.owner, ids.voice));
  expect(w.presence).toEqual([true, false, true]);
  expect(w.link().subscribed(ids.owner)).toBe(true);
  w.voice.close();
  await w.voice.done;
  expect(w.pending.size).toBe(0);
});

test("a replayed bot move stops voice before RESUMED instead of trusting its pre-gap channel", async () => {
  const w = readyWorld();
  const outcome = w.voice.done.then(
    () => "unexpected success",
    (error: Error) => error.message,
  );
  resume(w);
  w.dispatch("VOICE_STATE_UPDATE", state(ids.bot, ids.elsewhere));
  expect(w.driver.stopped).toBe(true);
  expect(w.presence.at(-1)).toBe(false);
  expect(w.link().stateUpdates.some((update) => update["channel_id"] === ids.elsewhere)).toBe(false);
  w.dispatch("RESUMED", {});
  w.playback.write(Buffer.alloc(48_000));
  expect(w.playback.queuedMs()).toBe(0);
  expect(await outcome).toBe("bot moved outside the configured voice channel");
  expect(w.pending.size).toBe(0);
});

test("ordered owner replay restores admission only at RESUMED and ignores unrelated or retired dispatches", async () => {
  const w = readyWorld();
  const retired = resume(w);
  retired.receive({ op: 0, s: 100, t: "VOICE_STATE_UPDATE", d: state(ids.bot, ids.elsewhere) });
  w.dispatch("VOICE_STATE_UPDATE", state(ids.owner, null));
  w.dispatch("VOICE_STATE_UPDATE", state(ids.owner, ids.voice));
  w.dispatch("VOICE_STATE_UPDATE", state(ids.owner, null, "another-guild"));
  w.dispatch("VOICE_STATE_UPDATE", state(ids.bot, ids.elsewhere, "another-guild"));
  w.dispatch("VOICE_STATE_UPDATE", state(ids.other, ids.elsewhere));
  w.dispatch("VOICE_STATE_UPDATE", state(ids.bot, ids.voice));
  expect(w.presence).toEqual([true, false]);
  expect(w.playback.audible).toBe(false);
  expect(w.link().subscribed(ids.owner)).toBe(false);
  expect(w.link().current).toBe("ready");
  expect(w.link().stateUpdates.at(-1)).toEqual(state(ids.bot, ids.voice));
  w.dispatch("RESUMED", {});
  expect(w.presence).toEqual([true, false, true]);
  expect(w.playback.audible).toBe(true);
  expect(w.link().subscribed(ids.owner)).toBe(true);
  w.voice.close();
  await w.voice.done;
  expect(w.pending.size).toBe(0);
});

test.each([false, true])("fresh READY requires fresh voice state (owner present: %s)", async (present) => {
  const w = readyWorld();
  resume(w);
  w.socket().receive({ op: 9, d: false });
  w.advance(5_000); // The initial IDENTIFY still owns its five-second window.
  expect(w.sockets).toHaveLength(3);
  w.socket().hello(HEARTBEAT);
  expect(w.socket().frames[0]).toMatchObject({ op: 2 });
  w.dispatch("VOICE_STATE_UPDATE", state(ids.owner, ids.voice));
  w.dispatch("VOICE_STATE_UPDATE", state(ids.bot, ids.voice));
  w.socket().ready();
  w.link().move("connecting");
  w.link().move("ready");
  expect(w.presence).toEqual([true, false]);
  expect(w.playback.audible).toBe(false);
  expect(w.link().subscribed(ids.owner)).toBe(false);
  w.dispatch("GUILD_CREATE", {
    id: ids.guild,
    voice_states: [state(ids.bot, ids.voice), ...(present ? [state(ids.owner, ids.voice)] : [])],
  });
  expect(w.presence.at(-1)).toBe(present);
  expect(w.link().subscribed(ids.owner)).toBe(present);
  if (!present) w.dispatch("VOICE_STATE_UPDATE", state(ids.owner, ids.voice));
  expect(w.presence).toEqual([true, false, true]);
  w.voice.close();
  await w.voice.done;
  expect(w.pending.size).toBe(0);
});
