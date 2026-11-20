/**
 * Joins the configured Discord voice channel for the owner. The optional native dependencies (@discordjs/voice,
 * @discordjs/opus and the DAVE library it loads) are imported only when a connection is started, so importing this
 * module costs nothing on installs without voice.
 */
import type * as Voice from "@discordjs/voice";
import { discordClock, openDiscordSocket } from "../cli-discord.ts";
import type { Discord } from "../messenger/discord.ts";
import type { Playback } from "./audio.ts";
import type { OpusCodec, VoiceDriver, VoiceLink } from "./discord-link.ts";
import { voiceServerUpdate, voiceStateUpdate } from "./discord-events.ts";
import { startDiscordVoice, voiceIds } from "./discord-session.ts";

/** stop(true) idles the player, but 0.19.2 keeps its already prepared packet on the connection's networking. */
const discardPrepared = (voice: typeof Voice, connection: Voice.VoiceConnection) => {
  const state = connection.state;
  if (!("networking" in state)) return;
  const networking = state.networking.state;
  if (networking.code === voice.NetworkingStatusCode.Ready || networking.code === voice.NetworkingStatusCode.Resuming) {
    networking.preparedPacket = undefined;
  }
};

const nativeLink = (
  voice: typeof Voice,
  connection: Voice.VoiceConnection,
  player: () => Voice.AudioPlayer | undefined,
): VoiceLink => ({
  status: () => connection.state.status,
  onStatus: (cb) => {
    connection.on("stateChange", (from, to) => cb(from.status, to.status));
  },
  onDebug: (cb) => {
    connection.on("debug", cb);
  },
  onError: (cb) => {
    connection.on("error", (error) => cb(error.message));
  },
  dave: () => {
    const state = connection.state;
    if (!("networking" in state)) return undefined;
    const networking = state.networking.state;
    return "dave" in networking ? networking.dave?.session : undefined;
  },
  attach: () => {
    const current = player();
    if (!current) return;
    const state = connection.state;
    if (!("subscription" in state) || state.subscription?.player !== current) discardPrepared(voice, connection);
    connection.subscribe(current);
  },
  destroy: () => {
    if (connection.state.status !== voice.VoiceConnectionStatus.Destroyed) connection.destroy();
  },
  subscribed: (userId) => connection.receiver.subscriptions.has(userId),
  speaking: (userId) => connection.receiver.speaking.users.has(userId),
  receive: (userId) => {
    const stream = connection.receiver.subscribe(userId, { end: { behavior: voice.EndBehaviorType.Manual } });
    return {
      onData: (cb) => {
        stream.on("data", cb);
      },
      onError: (cb) => {
        stream.on("error", (error) => cb(error.message));
      },
      onClose: (cb) => {
        stream.on("close", cb);
      },
      destroy: () => {
        stream.destroy();
      },
    };
  },
});

/** The production adapter, with optional native imports supplied by the lazy loader below. */
export const createNativeVoiceDriver = (voice: typeof Voice, codec: () => OpusCodec): VoiceDriver => {
  let player: Voice.AudioPlayer | undefined;
  let connection: Voice.VoiceConnection | undefined;
  return {
    codec,
    play: (source, log) => {
      player = voice.createAudioPlayer({
        behaviors: { noSubscriber: voice.NoSubscriberBehavior.Play, maxMissedFrames: Number.POSITIVE_INFINITY },
      });
      player.on("error", (error) => log(`PLAYER ERROR ${error.message}`));
      player.on("stateChange", (from, to) => log(`PLAYER ${from.status} -> ${to.status}`));
      player.play(voice.createAudioResource(source, { inputType: voice.StreamType.Opus }));
    },
    join: ({ guildId, channelId, adapter }) => {
      const current = voice.joinVoiceChannel({
        guildId,
        channelId,
        selfDeaf: false,
        selfMute: false,
        debug: true,
        // Past this many consecutive failures the library throws, which kills the receive stream; with transition
        // id 0 its recovery path is skipped (falsy id). Undecryptable packets are dropped and counted instead.
        decryptionFailureTolerance: 1_000_000,
        adapterCreator: (methods) =>
          adapter({
            // The bridge forwards only this guild's VOICE_SERVER_UPDATE and the bot's own VOICE_STATE_UPDATE.
            onVoiceServerUpdate: (data) => methods.onVoiceServerUpdate(voiceServerUpdate(data)),
            onVoiceStateUpdate: (data) => methods.onVoiceStateUpdate(voiceStateUpdate(data)),
          }),
      });
      connection = current;
      current.once(voice.VoiceConnectionStatus.Destroyed, () => {
        if (connection === current) connection = undefined;
      });
      return nativeLink(voice, current, () => player);
    },
    stop: () => {
      player?.stop(true);
      if (connection) discardPrepared(voice, connection);
    },
  };
};

const nativeDriver = async (): Promise<VoiceDriver> => {
  // Dynamic on purpose: these are optional native dependencies, absent or unloadable where voice is not used.
  const voice = await import("@discordjs/voice");
  const { OpusEncoder } = await import("@discordjs/opus");
  return createNativeVoiceDriver(voice, () => new OpusEncoder(48_000, 2));
};

export const connectDiscordVoice = async (options: {
  discord: Discord;
  token: string;
  ownerId: string;
  channelId: string;
  playback: Playback;
  onOwnerPresence(present: boolean): void;
  onPcm(pcm: Buffer): void;
  log(line: string): void;
}): Promise<{ done: Promise<void>; close(): void }> => {
  const driver = await nativeDriver();
  const ids = await voiceIds(options.discord, options.channelId);
  return startDiscordVoice(
    {
      token: options.token,
      ownerId: options.ownerId,
      channelId: options.channelId,
      ...ids,
      playback: options.playback,
      onOwnerPresence: options.onOwnerPresence,
      onPcm: options.onPcm,
      log: options.log,
    },
    { driver, open: openDiscordSocket, clock: discordClock },
  );
};
