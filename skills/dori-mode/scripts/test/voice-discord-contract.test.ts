import { expect, test } from "bun:test";
import { Playback } from "../src/voice/audio.ts";
import { startDiscordVoice } from "../src/voice/discord-session.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { FakeDriver, HEARTBEAT, ids, readyWorld, voiceWorld } from "./voice-discord-fakes.ts";

test("the bot cannot be configured as its own human voice owner", async () => {
  const driver = new FakeDriver();
  const { clock, pending } = gatewayTimers();
  const sockets: FakeGateway[] = [];
  let stop: (() => Promise<void>) | undefined;
  try {
    expect(() => {
      const voice = startDiscordVoice(
        {
          token: "synthetic-discord",
          ownerId: ids.bot,
          botId: ids.bot,
          guildId: ids.guild,
          channelId: ids.voice,
          playback: new Playback(),
          onOwnerPresence: () => {},
          onPcm: () => {},
          log: () => {},
        },
        {
          driver,
          clock,
          open: (url) => {
            const socket = new FakeGateway(url);
            sockets.push(socket);
            return socket;
          },
        },
      );
      stop = async () => {
        voice.close();
        await voice.done;
      };
    }).toThrow("DORI_DISCORD_OWNER_ID must identify the human owner, not the bot");
    expect(driver.codecs).toBe(0);
    expect(driver.source).toBeUndefined();
    expect(driver.links).toHaveLength(0);
    expect(sockets).toHaveLength(0);
    expect(pending.size).toBe(0);
  } finally {
    await stop?.();
  }
});

test.each(["initial", "rejoin"])("a native join exception settles and stops the bridge (%s)", async (phase) => {
  const w = phase === "initial" ? voiceWorld() : readyWorld();
  const outcome = w.voice.done.then(
    () => "unexpected success",
    (error: Error) => error.message,
  );
  let attempts = 0;
  w.driver.join = () => {
    attempts++;
    throw new Error("Synthetic native join failure");
  };
  try {
    if (phase === "initial") {
      w.socket().hello(HEARTBEAT);
      w.socket().ready();
    } else {
      w.link().move("disconnected");
      w.advance(5_000);
      w.advance(3_000);
    }
    expect(await outcome).toBe("Discord voice join failed");
    expect(attempts).toBe(1);
    expect(w.driver.stopped).toBe(true);
    if (phase === "initial") expect(w.driver.source).toBeUndefined();
    else expect(w.driver.source?.destroyed).toBe(true);
    expect(w.driver.links.every((link) => link.current === "destroyed")).toBe(true);
    expect(w.sockets.every((socket) => socket.closed)).toBe(true);
    expect(w.pending.size).toBe(0);
    w.advance(60_000);
    expect(attempts).toBe(1);
  } finally {
    w.voice.close();
    await outcome;
  }
});
