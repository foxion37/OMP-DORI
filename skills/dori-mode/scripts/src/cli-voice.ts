import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { release, tryTake } from "../../../../src/lock-owner.ts";
import { alive } from "./checkpoint-lock.ts";
import { type Command, die } from "./cli-context.ts";
import { untilStopped } from "./cli-discord.ts";
import { Discord } from "./messenger/discord.ts";
import { discordInboundEnv } from "./messenger/discord-inbound-state.ts";
import { fetchHttp } from "./messenger/http.ts";
import { realClock } from "./run.ts";
import { VoiceAssistant } from "./voice/assistant.ts";
import { Playback } from "./voice/audio.ts";
import { connectDiscordVoice } from "./voice/discord.ts";
import { openVoiceSocket } from "./voice/provider.ts";
import { Replies } from "./voice/replies.ts";
import { voiceSettings } from "./voice/settings.ts";
import { postVoiceText, summarizeVoice } from "./voice/summary.ts";
import { voiceTools } from "./voice/tools.ts";
import { VoiceUsage } from "./voice/usage.ts";

/** Opt-in only: normal Dori installation, boot and text intake never start voice or load native codecs. */
export const voiceCommand: Command = async ({ key: target, config, deps }) => {
  try {
    if (target !== "discord") die("usage: dori voice discord");
    const settings = voiceSettings(config.voice);
    const env = process.env;
    const ownerId = discordInboundEnv("DORI_DISCORD_OWNER_ID", env["DORI_DISCORD_OWNER_ID"]);
    const token = env["DORI_DISCORD_TOKEN"] || die("DORI_DISCORD_TOKEN is not set");
    const key = env[settings.apiKeyEnv] || die(`${settings.apiKeyEnv} is not set`);
    const directory = join(config.stateDir, "voice");
    mkdirSync(join(directory, "state"), { recursive: true, mode: 0o700 });
    const log = (line: string) => console.log(line);
    const lock = tryTake({ root: directory, pid: process.pid, now: Date.now, alive }, "discord-voice", "voice", log);
    if ("busy" in lock) throw new Error("Discord voice already has a live owner in this state directory");
    let timer: NodeJS.Timeout | undefined;
    let connection: { done: Promise<void>; close(): void } | undefined;
    let assistant: VoiceAssistant | undefined;
    try {
      const discord = new Discord(fetchHttp, realClock, token);
      const playback = new Playback();
      const usage = new VoiceUsage(directory, settings, Date.now);
      const replies = new Replies(directory, log);
      assistant = new VoiceAssistant(settings, {
        key,
        now: Date.now,
        open: openVoiceSocket,
        tool: voiceTools(deps, discord, settings),
        playback,
        replies,
        usage,
        log,
        notify: (text) => postVoiceText(discord, settings.textChannelId, text),
        summarize: (session) => summarizeVoice(session, settings, usage, key, discord),
      });
      const engine = assistant;
      timer = setInterval(() => engine.tick(), 40);
      connection = await connectDiscordVoice({
        discord,
        token,
        ownerId,
        channelId: settings.channelId,
        playback,
        onOwnerPresence: (present) => engine.ownerPresence(present),
        onPcm: (pcm) => engine.pcm(pcm),
        log,
      });
      const connected = connection;
      let stopping: Promise<void> | undefined;
      const stop = (): Promise<void> =>
        (stopping ??= (async () => {
          connected.close();
          await engine.stop();
        })());
      const done = connected.done.then(stop, async (error: unknown) => {
        await stop();
        throw error;
      });
      await untilStopped({
        done,
        close: () => {
          void stop();
        },
      });
    } finally {
      connection?.close();
      await assistant?.stop();
      clearInterval(timer);
      release(directory, "discord-voice", lock.owner);
    }
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
};
