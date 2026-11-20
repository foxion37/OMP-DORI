import { expect, test } from "bun:test";
import { Discord } from "../src/messenger/discord.ts";
import type { Http } from "../src/messenger/http.ts";
import { voiceIds } from "../src/voice/discord-session.ts";
import { HEARTBEAT, ids, readyWorld, voiceWorld } from "./voice-discord-fakes.ts";

const leave = { op: 4, d: { guild_id: ids.guild, channel_id: null } };
const botState = (channel: string | null) => ({
  guild_id: ids.guild,
  user_id: ids.bot,
  channel_id: channel,
  session_id: "s",
});

test("boot joins after READY, finds an owner already in the channel and receives only the owner", async () => {
  const w = voiceWorld();
  w.socket().hello(HEARTBEAT);
  expect(w.socket().frames[0]).toMatchObject({ op: 2, d: { intents: 1 | (1 << 7) } });
  expect(w.socket().frames[0]?.d).not.toHaveProperty("presence");
  expect(w.driver.links).toHaveLength(0);
  w.socket().ready();
  const link = w.link();
  expect(w.voiceFrames()).toEqual([
    { op: 4, d: { guild_id: ids.guild, channel_id: ids.voice, self_deaf: false, self_mute: false } },
  ]);
  w.dispatch("GUILD_CREATE", { id: "999", voice_states: [{ user_id: ids.owner, channel_id: ids.voice }] });
  expect(w.presence).toEqual([]);
  const states = [
    { user_id: ids.other, channel_id: ids.voice },
    { user_id: ids.owner, channel_id: ids.voice },
  ];
  w.dispatch("GUILD_CREATE", { id: ids.guild, voice_states: states });
  expect(w.presence).toEqual([]); // Do not open a paid session before the audio connection is ready.
  w.dispatch("VOICE_STATE_UPDATE", { ...botState(ids.voice), user_id: ids.other });
  w.dispatch("VOICE_STATE_UPDATE", { ...botState(ids.voice), guild_id: "999" });
  w.dispatch("VOICE_SERVER_UPDATE", { guild_id: "999", token: "private-voice-token", endpoint: "other.test" });
  expect(link.stateUpdates).toEqual([]);
  expect(link.serverUpdates).toEqual([]);
  w.dispatch("VOICE_STATE_UPDATE", botState(ids.voice));
  w.dispatch("VOICE_SERVER_UPDATE", { guild_id: ids.guild, token: "private-voice-token", endpoint: "voice.test" });
  expect(link.stateUpdates).toEqual([botState(ids.voice)]);
  expect(link.serverUpdates).toHaveLength(1);
  expect(link.streams).toHaveLength(0);
  link.move("ready");
  expect(w.presence).toEqual([true]);
  expect(link.attached).toBe(1);
  expect([...link.subscriptions.keys()]).toEqual([ids.owner]);
  link.streams[0]!.push(Buffer.from([5]));
  expect(w.pcm.map((chunk) => chunk[0])).toEqual([5]);
  link.withDave().debug("[DAVE] MLS commit processed (transition id: 1)");
  link.fault("udp socket error");
  w.advance(0);
  expect(link.passthrough).toEqual([
    [true, 30],
    [false, 30],
  ]);
  w.voice.close();
  await w.voice.done;
  expect(link.current).toBe("destroyed");
  expect(w.voiceFrames().at(-1)).toEqual(leave);
  expect(w.socket().closes).toEqual([1000]);
  expect(w.driver.stopped).toBe(true);
  expect(w.driver.source?.destroyed).toBe(true);
  expect(w.pending.size).toBe(0);
  expect(w.logs).toEqual([
    "VOICE_GATEWAY_READY discord event=READY",
    "VOICE signalling -> connecting",
    "VOICE connecting -> ready",
    "OWNER in channel",
    "DAVE MLS commit processed (transition id: 1)",
    "VOICE ERROR udp socket error",
    "DAVE passthrough window 30s; owner decryptor passthrough = true",
    "OWNER left channel",
    "VOICE_GATEWAY_STOPPED discord",
  ]);
});

test("the owner leaving, moving away and returning drives presence and the one subscription", async () => {
  const w = readyWorld();
  const link = w.link();
  expect(w.pending.size).toBe(2); // the Gateway heartbeat and the stall alarm
  w.dispatch("VOICE_STATE_UPDATE", { guild_id: ids.guild, user_id: ids.owner, channel_id: ids.elsewhere });
  expect(w.presence).toEqual([true, false]);
  expect(link.streams[0]!.destroyed).toBe(true);
  expect(w.pending.size).toBe(1);
  w.dispatch("VOICE_STATE_UPDATE", { guild_id: ids.guild, user_id: ids.owner, channel_id: null });
  w.advance(60_000);
  expect(w.presence).toEqual([true, false]);
  expect(link.streams).toHaveLength(1);
  w.dispatch("VOICE_STATE_UPDATE", { guild_id: ids.guild, user_id: ids.owner, channel_id: ids.voice });
  expect(w.presence).toEqual([true, false, true]);
  expect(link.streams).toHaveLength(2);
  expect(link.subscribed(ids.owner)).toBe(true);
  w.voice.close();
  await w.voice.done;
  expect(link.streams[1]!.destroyed).toBe(true);
  expect(w.pending.size).toBe(0);
});

test("a kicked bot rejoins after 5 s disconnected plus 3 s, while a recovery within 5 s is kept", async () => {
  const w = readyWorld();
  const first = w.link();
  w.dispatch("VOICE_STATE_UPDATE", botState(null));
  expect(first.stateUpdates.at(-1)).toEqual(botState(null));
  first.move("disconnected");
  w.advance(4_999);
  first.move("signalling");
  w.advance(10_000);
  expect(w.driver.links).toHaveLength(1);
  first.move("disconnected");
  w.advance(5_000);
  expect(w.logs.at(-1)).toBe("VOICE disconnected for good; rejoining");
  expect(first.current).toBe("destroyed");
  expect(first.streams[0]!.destroyed).toBe(true);
  expect(w.voiceFrames().at(-1)).toEqual(leave);
  w.advance(2_999);
  expect(w.driver.links).toHaveLength(1);
  w.advance(1);
  const second = w.link();
  expect(second).not.toBe(first);
  expect(w.voiceFrames().at(-1)?.d).toMatchObject({ channel_id: ids.voice });
  w.dispatch("VOICE_STATE_UPDATE", botState(ids.voice));
  w.dispatch("VOICE_SERVER_UPDATE", { guild_id: ids.guild, token: "private-voice-token", endpoint: "voice.test" });
  expect(first.stateUpdates).toHaveLength(2);
  expect(second.stateUpdates).toEqual([botState(ids.voice)]);
  second.move("ready");
  expect(second.subscribed(ids.owner)).toBe(true);
  expect(w.presence).toEqual([true, false, true]);
  first.move("ready");
  expect(first.attached).toBe(1);
  expect(w.pending.size).toBe(2);
  w.voice.close();
  await w.voice.done;
  expect(w.pending.size).toBe(0);
  expect(w.logs.join("\n")).not.toMatch(/private/);
});

test("rejoins while the Gateway is away end the bridge 30 s after the first, not retrying forever", async () => {
  const w = readyWorld();
  const first = w.link();
  const outcome = w.voice.done.then(
    () => undefined,
    (error: Error) => error.message,
  );
  w.socket().disconnect(1006);
  expect(w.logs.at(-1)).toBe("VOICE_GATEWAY_RECONNECT discord reason=closed code=1006 retry_in=5s");
  first.move("disconnected");
  w.advance(8_000);
  expect(w.driver.links).toHaveLength(2);
  expect(w.link().current).toBe("disconnected"); // the join request could not be sent
  w.advance(21_999);
  expect(w.driver.links).toHaveLength(4);
  expect(w.logs.filter((line) => line === "VOICE disconnected for good; rejoining")).toHaveLength(4);
  w.advance(1);
  expect(await outcome).toBe("voice connection was not ready within 30s");
  expect(w.logs).toContain("VOICE STOPPED voice connection was not ready within 30s");
  expect(w.driver.links.every((link) => link.current === "destroyed")).toBe(true);
  expect(w.sockets.every((socket) => socket.closed)).toBe(true);
  expect(w.driver.stopped).toBe(true);
  expect(w.pending.size).toBe(0);
});

test("a terminal Gateway close ends the bridge with that error and releases everything", async () => {
  const w = readyWorld();
  w.socket().disconnect(4004);
  const error = await w.voice.done.then(
    () => undefined,
    (e: Error) => e.message,
  );
  expect(error).toBe("Discord gateway closed code=4004 (authentication failed)");
  expect(w.link().current).toBe("destroyed");
  expect(w.link().streams[0]!.destroyed).toBe(true);
  expect(w.driver.stopped).toBe(true);
  expect(w.pending.size).toBe(0);
  expect(w.logs.join("\n")).not.toMatch(/private/);
});

test("guild and bot ids come from REST, and a channel that is not a guild voice channel is refused", async () => {
  const routes: Record<string, unknown> = {
    [`/channels/${ids.voice}`]: { id: ids.voice, type: 2, guild_id: ids.guild },
    "/channels/20": { id: "20", type: 0, guild_id: ids.guild },
    "/users/@me": { id: ids.bot },
  };
  const requests: string[] = [];
  const http: Http = async (req) => {
    const path = new URL(req.url).pathname.replace("/api/v10", "");
    requests.push(`${req.method} ${path}`);
    return { status: 200, headers: {}, body: JSON.stringify(routes[path]) };
  };
  const discord = new Discord(http, { now: () => 0, sleep: async () => {} }, "private-bot-token");
  expect(await voiceIds(discord, ids.voice)).toEqual({ guildId: ids.guild, botId: ids.bot });
  await expect(voiceIds(discord, "20")).rejects.toThrow("Discord channel 20 is not a guild voice channel");
  expect(requests).toEqual([`GET /channels/${ids.voice}`, "GET /users/@me", "GET /channels/20"]);
});

test("stopping before READY or during a pending rejoin cancels all future work", async () => {
  const early = voiceWorld();
  early.voice.close();
  early.voice.close();
  await early.voice.done;
  early.socket().hello(HEARTBEAT);
  early.socket().ready();
  expect(early.driver.links).toHaveLength(0);
  expect(early.pending.size).toBe(0);

  const w = readyWorld();
  w.link().move("disconnected");
  w.advance(5_000);
  w.voice.close();
  w.advance(60_000);
  await w.voice.done;
  expect(w.driver.links).toHaveLength(1);
  expect(w.pending.size).toBe(0);
  w.dispatch("VOICE_STATE_UPDATE", { guild_id: ids.guild, user_id: ids.owner, channel_id: null });
  expect(w.presence).toEqual([true, false]);
});
