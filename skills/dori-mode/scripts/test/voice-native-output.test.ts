import { expect, spyOn, test } from "bun:test";
import * as Voice from "@discordjs/voice";
import type { Readable } from "node:stream";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { HEARTBEAT, ids } from "./voice-discord-fakes.ts";
import { nativeWorld } from "./voice-native-output-fixture.ts";

test.each(["gateway", "native-resume"] as const)("native Opus does not leak across %s", async (gap) => {
  expect(Voice.version).toBe("0.19.2");
  const w = nativeWorld();
  const staged = Promise.withResolvers<{
    packet: Buffer;
    source: Readable;
    player: Voice.AudioPlayer;
    resource: Voice.AudioResource;
    buffered: number;
    queued: number;
    retained: boolean;
    nonce: number;
  }>();
  const preparations: { opus: Buffer; packet: Buffer }[] = [];
  let revoked = false;
  const prepare = w.networking.prepareAudioPacket.bind(w.networking);
  const observation = spyOn(w.networking, "prepareAudioPacket").mockImplementation((opus) => {
    const packet = prepare(opus);
    if (packet) preparations.push({ opus, packet });
    if (packet && !revoked) {
      revoked = true;
      const player = w.player();
      const state = player.state;
      if (!("resource" in state)) throw new Error("Audio was prepared without a resource");
      const source = w.sources.at(-1)!;
      const snapshot = {
        packet,
        source,
        player,
        resource: state.resource,
        buffered: source.readableLength,
        queued: w.playback.queuedMs(),
        retained: false,
        nonce: w.networkState.connectionData.nonce,
      };
      w.links.at(-1)!.attach(); // Idempotent reattachment must not discard a current generation's packet.
      snapshot.retained = w.networkState.preparedPacket === packet;
      if (gap === "gateway") w.socket().receive({ op: 7 });
      else {
        w.networking.state = { ...w.networkState, code: Voice.NetworkingStatusCode.Resuming };
        w.move(Voice.VoiceConnectionStatus.Connecting);
      }
      staged.resolve(snapshot);
    }
    return packet;
  });
  try {
    expect(w.presence).toEqual([true]);
    const admitted = w.player();
    w.dispatch("VOICE_STATE_UPDATE", { guild_id: ids.guild, user_id: ids.other, channel_id: ids.voice });
    expect(w.player()).toBe(admitted);
    expect(w.connection.receiver.subscriptions.has(ids.other)).toBe(false);
    expect(w.presence).toEqual([true]);
    w.playback.write(Buffer.alloc(960 * 3, 0x10));
    // Let the SDK's real public player/scheduler prepare its first frame; revocation happens synchronously above.
    const old = await staged.promise;
    expect(old.retained).toBe(true);
    expect(old.buffered).toBeGreaterThan(0);
    expect(old.queued).toBeGreaterThan(0);
    expect(old.resource.playStream).toBe(old.source);
    expect(old.source.destroyed).toBe(true);
    expect(old.player.state.status).toBe(Voice.AudioPlayerStatus.Idle);
    expect(w.playback.audible).toBe(false);
    expect(w.playback.queuedMs()).toBe(0);
    if (gap === "gateway") expect(w.connection.dispatchAudio()).toBe(false);
    expect("preparedPacket" in w.networking.state && w.networking.state.preparedPacket).toBeUndefined();
    expect(w.networkState.connectionData.nonce).toBe(old.nonce); // Discarding does not encrypt replacement silence.
    expect(w.sent).toEqual([]);
    expect(w.signalling).toEqual([]);
    const buffered = w.encoded[1]!;
    const count = w.sources.length;
    w.playback.write(Buffer.alloc(960, 0x20)); // Audio arriving while suspended is dropped.
    await nextImmediate();
    expect(w.sent).toEqual([]);
    if (gap === "gateway") {
      expect(w.presence.at(-1)).toBe(false);
      w.advance(0);
      w.socket().hello(HEARTBEAT);
      expect(w.socket().frames[0]).toMatchObject({ op: 6 });
      w.dispatch("VOICE_STATE_UPDATE", { guild_id: ids.guild, user_id: ids.other, channel_id: ids.voice });
      expect(w.sources).toHaveLength(count);
      expect(w.playback.audible).toBe(false);
      w.dispatch("RESUMED", {});
    } else {
      const suspended = w.networking.state;
      if (suspended.code !== Voice.NetworkingStatusCode.Resuming)
        throw new Error("Native networking did not enter resume");
      w.networking.state = { ...suspended, code: Voice.NetworkingStatusCode.Ready };
      w.move(Voice.VoiceConnectionStatus.Ready);
    }
    expect(w.playback.audible).toBe(true);
    expect(w.sources).toHaveLength(count + 1);
    expect(w.sources.at(-1)).not.toBe(old.source);
    expect(w.player()).not.toBe(old.player);
    expect(w.connection.dispatchAudio()).toBe(false); // No old packet is sent before the replacement resource produces one.
    w.playback.write(Buffer.alloc(960, 0x30));
    const actual = await w.transmitted.promise;
    expect(actual.equals(old.packet)).toBe(false);
    const fresh = preparations.find(({ packet }) => packet.equals(actual));
    expect(fresh).toBeDefined();
    expect(fresh!.opus.toString()).toBe("opus:3840:6168");
    expect(preparations.some(({ opus }) => opus === buffered)).toBe(false);
    expect(w.sent).toHaveLength(1);
    if (gap === "gateway") expect(w.presence).toEqual([true, false, true]);
  } finally {
    w.bridge.close();
    await w.bridge.done;
    observation.mockRestore();
  }
  expect(w.sources.every((source) => source.destroyed)).toBe(true);
  expect(w.connection.state.status).toBe(Voice.VoiceConnectionStatus.Destroyed);
  expect(Voice.getVoiceConnection(ids.guild)).toBeUndefined();
  expect(w.pending.size).toBe(0);
});
