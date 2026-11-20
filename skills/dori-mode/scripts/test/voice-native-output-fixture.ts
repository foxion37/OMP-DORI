import * as Voice from "@discordjs/voice";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { Playback } from "../src/voice/audio.ts";
import { createNativeVoiceDriver } from "../src/voice/discord.ts";
import type { VoiceLink } from "../src/voice/discord-link.ts";
import { startDiscordVoice } from "../src/voice/discord-session.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { fakeCodec, HEARTBEAT, ids } from "./voice-discord-fakes.ts";

export const nativeWorld = () => {
  const { clock, pending, advance } = gatewayTimers();
  const sockets: FakeGateway[] = [];
  const sources: Readable[] = [];
  const links: VoiceLink[] = [];
  const encoded: Buffer[] = [];
  const sent: Buffer[] = [];
  const signalling: unknown[] = [];
  const presence: boolean[] = [];
  const transmitted = Promise.withResolvers<Buffer>();
  const codec = fakeCodec();
  const encode = codec.encode;
  codec.encode = (pcm) => {
    const packet = encode(pcm);
    encoded.push(packet);
    return packet;
  };
  const driver = createNativeVoiceDriver(Voice, () => codec);
  const play = driver.play;
  driver.play = (source, log) => {
    sources.push(source);
    play(source, log);
  };
  const join = driver.join;
  driver.join = (options) => {
    const link = join(options);
    links.push(link);
    return link;
  };
  const playback = new Playback();
  const bridge = startDiscordVoice(
    {
      token: "offline-discord-token",
      ownerId: ids.owner,
      botId: ids.bot,
      guildId: ids.guild,
      channelId: ids.voice,
      playback,
      onOwnerPresence: (present) => presence.push(present),
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
  let seq = 3;
  const socket = () => sockets.at(-1)!;
  const dispatch = (t: string, d: unknown) => socket().receive({ op: 0, s: ++seq, t, d });
  socket().hello(HEARTBEAT);
  socket().ready();
  dispatch("GUILD_CREATE", {
    id: ids.guild,
    voice_states: [
      { user_id: ids.owner, channel_id: ids.voice },
      { user_id: ids.bot, channel_id: ids.voice },
    ],
  });
  const connection = Voice.getVoiceConnection(ids.guild);
  if (!connection) throw new Error("No offline native voice connection");
  const udp = Object.assign(new EventEmitter(), {
    send: (packet: Buffer) => {
      const copy = Buffer.from(packet);
      sent.push(copy);
      transmitted.resolve(copy);
    },
    destroy: () => {},
  });
  const ws = Object.assign(new EventEmitter(), {
    sendPacket: (packet: unknown) => signalling.push(packet),
    destroy: () => {},
  });
  const networkState: Voice.NetworkingReadyState = {
    code: Voice.NetworkingStatusCode.Ready,
    connectionOptions: {
      channelId: ids.voice,
      endpoint: "offline.invalid",
      serverId: ids.guild,
      sessionId: "offline",
      token: "offline-voice-token",
      userId: ids.bot,
    },
    connectionData: {
      connectedClients: new Set(),
      encryptionMode: "aead_aes256_gcm_rtpsize",
      nonce: 0,
      nonceBuffer: Buffer.alloc(12),
      packetsPlayed: 0,
      secretKey: Buffer.alloc(32),
      sequence: 0,
      speaking: false,
      ssrc: 1,
      timestamp: 0,
    },
    udp: udp as unknown as Voice.VoiceUDPSocket,
    ws: ws as unknown as Voice.VoiceWebSocket,
  };
  // Skip only the socket-opening constructor. Packet preparation, AES encryption and dispatch are the real SDK methods.
  const networking = Object.create(Voice.Networking.prototype) as Voice.Networking;
  Object.defineProperty(networking, "state", { value: networkState, writable: true });
  const move = (status: Voice.VoiceConnectionStatus.Ready | Voice.VoiceConnectionStatus.Connecting) => {
    const state = connection.state;
    if (!("adapter" in state)) throw new Error("No adapter on offline native connection");
    const { adapter, subscription } = state;
    connection.state = { adapter, subscription, status, networking };
  };
  move(Voice.VoiceConnectionStatus.Ready);
  const player = () => {
    const state = connection.state;
    if (state.status !== Voice.VoiceConnectionStatus.Ready || !state.subscription)
      throw new Error("No native player subscription");
    return state.subscription.player;
  };
  return {
    bridge,
    pending,
    advance,
    sources,
    links,
    encoded,
    sent,
    signalling,
    presence,
    transmitted,
    playback,
    socket,
    dispatch,
    connection,
    networking,
    networkState,
    player,
    move,
  };
};
