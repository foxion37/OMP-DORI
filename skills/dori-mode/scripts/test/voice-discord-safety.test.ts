import { expect, test } from "bun:test";
import { ids, readyWorld } from "./voice-discord-fakes.ts";

test("moving the bot away stops the configured-channel session and drops all subsequent output", async () => {
  const w = readyWorld();
  const outcome = w.voice.done.then(
    () => "unexpected success",
    (error: Error) => error.message,
  );
  w.playback.write(Buffer.alloc(48_000));
  expect(w.playback.queuedMs()).toBe(1000);
  w.dispatch("VOICE_STATE_UPDATE", {
    guild_id: ids.guild,
    user_id: ids.bot,
    channel_id: ids.elsewhere,
    session_id: "moved",
  });
  expect(w.presence).toEqual([true, false]);
  expect(w.driver.stopped).toBe(true);
  expect(w.playback.queuedMs()).toBe(0);
  expect(w.link().stateUpdates.some((state) => state["channel_id"] === ids.elsewhere)).toBe(false);
  w.playback.write(Buffer.alloc(48_000));
  expect(w.playback.queuedMs()).toBe(0);
  expect(await outcome).toBe("bot moved outside the configured voice channel");
  expect(w.pending.size).toBe(0);
});

test.each(["signalling", "connecting"])("SDK recovery stuck in %s has its own 30-second deadline", async (state) => {
  const w = readyWorld();
  const outcome = w.voice.done.then(
    () => "unexpected success",
    (error: Error) => error.message,
  );
  w.link().move(state);
  w.advance(29_999);
  expect(w.link().current).toBe(state);
  expect(w.socket().closed).toBe(false);
  w.advance(1);
  expect(await outcome).toBe("voice connection was not ready within 30s");
  expect(w.presence).toEqual([true, false]);
  expect(w.pending.size).toBe(0);
});

test("a short connection blip mutes and invalidates playback without ending the owner's Live session", async () => {
  const w = readyWorld();
  const generation = w.playback.generation;
  w.playback.write(Buffer.alloc(48_000));
  w.link().move("disconnected");
  expect(w.presence).toEqual([true]);
  expect(w.playback.audible).toBe(false);
  expect(w.playback.queuedMs()).toBe(0);
  expect(w.playback.generation).toBeGreaterThan(generation);
  w.playback.write(Buffer.alloc(48_000));
  expect(w.playback.queuedMs()).toBe(0);
  w.advance(4999);
  w.link().move("connecting");
  w.link().move("ready");
  expect(w.presence).toEqual([true]);
  expect(w.playback.audible).toBe(true);
  expect(w.driver.links).toHaveLength(1);
  w.voice.close();
  await w.voice.done;
  expect(w.pending.size).toBe(0);
});
