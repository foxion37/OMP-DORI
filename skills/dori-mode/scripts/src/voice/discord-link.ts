/**
 * The narrow surface the Discord voice bridge needs from @discordjs/voice and @discordjs/opus. `discord.ts` maps the
 * native libraries onto it when a connection is started; tests drive the same bridge through fakes.
 */
import { Readable } from "node:stream";
import type { Playback } from "./audio.ts";

/** A 48 kHz stereo Opus codec instance. */
export type OpusCodec = { encode(pcm: Buffer): Buffer; decode(packet: Buffer): Buffer };

/** A Gateway dispatch body that the bridge checked belongs to this guild and, for voice states, to the bot. */
export type VoiceDispatch = Readonly<Record<string, unknown>>;

/** The library side of a Gateway adapter: where the bot's VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE go. */
export type AdapterMethods = {
  onVoiceServerUpdate(data: VoiceDispatch): void;
  onVoiceStateUpdate(data: VoiceDispatch): void;
};
/** The bridge side: sends the library's voice state requests on the current Gateway connection. */
export type GatewayAdapter = { sendPayload(payload: unknown): boolean; destroy(): void };
export type AdapterCreator = (methods: AdapterMethods) => GatewayAdapter;

/** The DAVE session controls used to open the finite passthrough window. */
export type DaveControls = {
  setPassthroughMode(passthrough: boolean, expiry: number): void;
  canPassthrough(userId: string): boolean;
};

/** One user's received Opus packets; it ends only when destroyed or when the library fails to parse a packet. */
export type OwnerStream = {
  onData(cb: (packet: Buffer) => void): void;
  onError(cb: (message: string) => void): void;
  onClose(cb: () => void): void;
  destroy(): void;
};

/** What the owner receiver needs from a live connection. */
export type ReceiveLink = {
  subscribed(userId: string): boolean;
  speaking(userId: string): boolean;
  receive(userId: string): OwnerStream;
};

/** One voice connection, from joinVoiceChannel until destroy. Statuses are @discordjs/voice VoiceConnectionStatus. */
export type VoiceLink = ReceiveLink & {
  status(): string;
  onStatus(cb: (from: string, to: string) => void): void;
  onDebug(cb: (message: string) => void): void;
  onError(cb: (message: string) => void): void;
  dave(): DaveControls | undefined;
  /** Subscribes the current admitted player to this connection. */
  attach(): void;
  /** Destroys the connection, leaving the channel; a no-op once destroyed. */
  destroy(): void;
};

export type VoiceDriver = {
  codec(): OpusCodec;
  /** Starts a fresh player/resource for an admitted output generation, reading Opus frames from `source`. */
  play(source: Readable, log: (line: string) => void): void;
  join(options: { guildId: string; channelId: string; adapter: AdapterCreator }): VoiceLink;
  /** Immediately stops the player and discards any packet prepared on its current connection. */
  stop(): void;
};

/**
 * Feeds the player one Opus frame per demand, with at most one encoded frame buffered ahead. With nothing queued the
 * stream waits for the next write. Admission revocation must destroy this stream as well as clear the PCM queue.
 */
export const playbackSource = (playback: Playback, encoder: OpusCodec): Readable => {
  let waiting = false;
  const pump = () => {
    const frame = playback.read();
    if (!frame) {
      waiting = true;
      return;
    }
    waiting = false;
    stream.push(encoder.encode(frame));
  };
  const stream = new Readable({ objectMode: true, highWaterMark: 1, read: pump });
  const readable = () => {
    if (waiting && !stream.destroyed) pump();
  };
  playback.onReadable = readable;
  stream.once("close", () => {
    if (playback.onReadable === readable) playback.onReadable = undefined;
  });
  return stream;
};
