/** The Discord Gateway plumbing shared by `dori presence discord` and `dori inbound discord --gateway`. */
import { die, every } from "./cli-context.ts";
import { Discord } from "./messenger/discord.ts";
import type { GatewayClock, GatewaySocket } from "./messenger/discord-gateway.ts";
import { discordInbound, formatDiscordInbound } from "./messenger/discord-inbound.ts";
import { discordInboundLive } from "./messenger/discord-inbound-live.ts";
import { discordInboundEnv, fileDiscordInboundStore } from "./messenger/discord-inbound-state.ts";
import { fetchHttp } from "./messenger/http.ts";
import { realClock } from "./run.ts";

export const openDiscordSocket = (url: string): GatewaySocket => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
    onMessage: (cb) => ws.addEventListener("message", (event) => cb(String(event.data))),
    onClose: (cb) => ws.addEventListener("close", (event) => cb(event.code)),
    onError: (cb) => ws.addEventListener("error", () => cb()),
  };
};

export const discordClock: GatewayClock = {
  now: realClock.now,
  random: Math.random,
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Waits for a Gateway connection to end, closing it on SIGINT or SIGTERM. */
export const untilStopped = async (gateway: { done: Promise<void>; close(): void }): Promise<void> => {
  const stop = () => gateway.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await gateway.done;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    gateway.close();
  }
};

const idList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

/** Channels come from DORI_DISCORD_CHANNEL_ID, DORI_DISCORD_CHANNEL_IDS (comma separated) and DORI_DISCORD_SCOPE=all. */
export const discordInboundCommand = async (stateDir: string, gateway: boolean, pollMinutes: number) => {
  const env = process.env;
  const ownerId = discordInboundEnv("DORI_DISCORD_OWNER_ID", env["DORI_DISCORD_OWNER_ID"]);
  const scope = env["DORI_DISCORD_SCOPE"]?.trim();
  if (scope !== undefined && scope !== "" && scope !== "all") die("DORI_DISCORD_SCOPE must be all or unset");
  const all = scope === "all";
  const channelIds = ["DORI_DISCORD_CHANNEL_ID", "DORI_DISCORD_CHANNEL_IDS"].flatMap((name) =>
    idList(env[name]).map((id) => discordInboundEnv(name, id)),
  );
  if (!all && channelIds.length === 0) discordInboundEnv("DORI_DISCORD_CHANNEL_ID", env["DORI_DISCORD_CHANNEL_ID"]);
  const token = env["DORI_DISCORD_TOKEN"] || die("DORI_DISCORD_TOKEN is not set");
  const intake = await discordInbound(
    new Discord(fetchHttp, realClock, token),
    (channelId) => fileDiscordInboundStore(stateDir, channelId),
    { ownerId, channelIds: [...new Set(channelIds)], all },
  );
  const watching = all ? "all" : intake.channels().join(",");
  const emit = (message: Parameters<typeof formatDiscordInbound>[0]) => console.log(formatDiscordInbound(message));
  console.log(
    `INBOUND_READY discord owner=${ownerId} channel=${watching} bot=${intake.botId}${gateway ? " mode=gateway" : ""}`,
  );
  if (!gateway) return await every(pollMinutes, () => intake.poll(emit));
  await untilStopped(discordInboundLive(intake, openDiscordSocket, token, discordClock, emit, (l) => console.log(l)));
};
