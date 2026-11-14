import { discordGateway, type GatewayClock, type GatewaySocket } from "./discord-gateway.ts";

const GUILD_MESSAGES = 1 << 9;

/** Keeps the bot shown as online over one Gateway connection that subscribes to a single, unused event class. */
export const discordPresence = (
  open: (url: string) => GatewaySocket,
  token: string,
  clock: GatewayClock,
  report: (line: string) => void,
) => discordGateway(open, token, clock, report, { label: "PRESENCE", intents: GUILD_MESSAGES, online: true });
