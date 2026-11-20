import type { Readable } from "node:stream";
import { Playback } from "../src/voice/audio.ts";
import type {
  AdapterCreator,
  DaveControls,
  GatewayAdapter,
  OpusCodec,
  OwnerStream,
  VoiceDispatch,
  VoiceDriver,
  VoiceLink,
} from "../src/voice/discord-link.ts";
import { startDiscordVoice } from "../src/voice/discord-session.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";

export const ids = { guild: "100", voice: "200", elsewhere: "201", owner: "300", other: "301", bot: "400" } as const;
/** A Gateway heartbeat interval long enough that no scenario here has to acknowledge one (first beat at 30 min). */
export const HEARTBEAT = 3_600_000;

/**
 * Encodes a frame as its length and first sample; decodes a packet into a 20 ms frame filled with its first byte.
 * A packet starting 0xff is corrupt.
 */
export const fakeCodec = (): OpusCodec => ({
  encode: (pcm) => Buffer.from(`opus:${pcm.length}:${pcm.readInt16LE(0)}`),
  decode: (packet) => {
    if (packet[0] === 0xff) throw new Error("corrupt opus packet");
    return Buffer.alloc(3840, packet[0] ?? 0);
  },
});

export class FakeStream implements OwnerStream {
  destroyed = false;
  private data: ((packet: Buffer) => void) | undefined;
  private error: ((message: string) => void) | undefined;
  private readonly closers: (() => void)[] = [];

  constructor(
    private readonly link: FakeLink,
    readonly userId: string,
  ) {}
  onData(cb: (packet: Buffer) => void) {
    this.data = cb;
  }
  onError(cb: (message: string) => void) {
    this.error = cb;
  }
  onClose(cb: () => void) {
    this.closers.push(cb);
  }
  push(packet: Buffer) {
    if (!this.destroyed) this.data?.(packet);
  }
  /** What the library does with a packet it cannot parse: destroy the stream with the error. */
  fail(message: string) {
    this.error?.(message);
    this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.link.subscriptions.get(this.userId) === this) this.link.subscriptions.delete(this.userId);
    for (const close of this.closers) close();
  }
}

export class FakeLink implements VoiceLink {
  current = "signalling";
  attached = 0;
  readonly subscriptions = new Map<string, FakeStream>();
  readonly streams: FakeStream[] = [];
  readonly speakingUsers = new Set<string>();
  readonly stateUpdates: VoiceDispatch[] = [];
  readonly serverUpdates: VoiceDispatch[] = [];
  readonly passthrough: [boolean, number][] = [];
  daveSession: DaveControls | undefined;
  daveFails = false;
  private readonly statusCbs: ((from: string, to: string) => void)[] = [];
  private readonly debugCbs: ((message: string) => void)[] = [];
  private readonly errorCbs: ((message: string) => void)[] = [];
  readonly adapter: GatewayAdapter;

  constructor(
    readonly guildId: string,
    readonly channelId: string,
    create: AdapterCreator,
  ) {
    this.adapter = create({
      onVoiceStateUpdate: (data) => this.stateUpdates.push(data),
      onVoiceServerUpdate: (data) => {
        this.serverUpdates.push(data);
        this.move("connecting");
      },
    });
    const join = { op: 4, d: { guild_id: guildId, channel_id: channelId, self_deaf: false, self_mute: false } };
    if (!this.adapter.sendPayload(join)) this.current = "disconnected"; // Before any listener, as the library does.
  }
  status() {
    return this.current;
  }
  onStatus(cb: (from: string, to: string) => void) {
    this.statusCbs.push(cb);
  }
  onDebug(cb: (message: string) => void) {
    this.debugCbs.push(cb);
  }
  onError(cb: (message: string) => void) {
    this.errorCbs.push(cb);
  }
  dave() {
    return this.daveSession;
  }
  /** Like VoiceConnection.subscribe, storing the subscription emits a same-status state change. */
  attach() {
    this.attached++;
    this.move(this.current);
  }
  destroy() {
    if (this.current === "destroyed") return;
    this.adapter.sendPayload({ op: 4, d: { guild_id: this.guildId, channel_id: null } });
    for (const stream of this.subscriptions.values()) stream.destroy();
    this.move("destroyed");
    this.adapter.destroy();
  }
  subscribed(userId: string) {
    return this.subscriptions.has(userId);
  }
  speaking(userId: string) {
    return this.speakingUsers.has(userId);
  }
  receive(userId: string) {
    const stream = new FakeStream(this, userId);
    this.subscriptions.set(userId, stream);
    this.streams.push(stream);
    return stream;
  }
  move(to: string) {
    const from = this.current;
    this.current = to;
    for (const cb of this.statusCbs) cb(from, to);
  }
  debug(message: string) {
    for (const cb of this.debugCbs) cb(message);
  }
  fault(message: string) {
    for (const cb of this.errorCbs) cb(message);
  }
  /** A DAVE session that records each passthrough call. */
  withDave(ownerPassthrough = true) {
    this.daveSession = {
      setPassthroughMode: (passthrough, expiry) => {
        if (this.daveFails) throw new Error("session not ready");
        this.passthrough.push([passthrough, expiry]);
      },
      canPassthrough: () => ownerPassthrough,
    };
    return this;
  }
}

export class FakeDriver implements VoiceDriver {
  readonly links: FakeLink[] = [];
  source: Readable | undefined;
  codecs = 0;
  stopped = false;

  codec() {
    this.codecs++;
    return fakeCodec();
  }
  play(source: Readable) {
    this.source = source;
  }
  join(options: { guildId: string; channelId: string; adapter: AdapterCreator }) {
    const link = new FakeLink(options.guildId, options.channelId, options.adapter);
    this.links.push(link);
    return link;
  }
  stop() {
    this.stopped = true;
  }
}

/** A voice bridge over a fake Gateway, a fake voice library and a manual clock. */
export const voiceWorld = () => {
  const { clock, pending, advance } = gatewayTimers();
  const sockets: FakeGateway[] = [];
  const driver = new FakeDriver();
  const playback = new Playback();
  const logs: string[] = [];
  const presence: boolean[] = [];
  const pcm: Buffer[] = [];
  let seq = 3;
  const voice = startDiscordVoice(
    {
      token: "private-bot-token",
      ownerId: ids.owner,
      channelId: ids.voice,
      guildId: ids.guild,
      botId: ids.bot,
      playback,
      onOwnerPresence: (present) => presence.push(present),
      onPcm: (chunk) => pcm.push(chunk),
      log: (line) => logs.push(line),
    },
    {
      driver,
      clock,
      open: (url) => {
        if (sockets.some((socket) => !socket.closed)) throw new Error("overlapping gateway sockets");
        const socket = new FakeGateway(url);
        sockets.push(socket);
        return socket;
      },
    },
  );
  const socket = () => sockets.at(-1)!;
  const dispatch = (t: string, d: unknown) => socket().receive({ op: 0, s: ++seq, t, d });
  const link = () => driver.links.at(-1)!;
  const voiceFrames = () => sockets.flatMap((s) => s.frames.filter((frame) => frame.op === 4));
  return {
    voice,
    sockets,
    driver,
    playback,
    logs,
    presence,
    pcm,
    pending,
    advance,
    socket,
    dispatch,
    link,
    voiceFrames,
  };
};

/** Owner and bot both in the channel with a ready connection, as after a normal boot. */
export const readyWorld = () => {
  const w = voiceWorld();
  w.socket().hello(HEARTBEAT);
  w.socket().ready();
  w.dispatch("GUILD_CREATE", { id: ids.guild, voice_states: [{ user_id: ids.owner, channel_id: ids.voice }] });
  w.dispatch("VOICE_STATE_UPDATE", { guild_id: ids.guild, user_id: ids.bot, channel_id: ids.voice, session_id: "s" });
  w.dispatch("VOICE_SERVER_UPDATE", { guild_id: ids.guild, token: "private-voice-token", endpoint: "voice.test" });
  w.link().move("ready");
  return w;
};
