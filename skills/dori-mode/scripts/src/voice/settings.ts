import { isDiscordSnowflake } from "../messenger/discord-inbound-state.ts";

export type TokenPrices = { input: number; cached: number; cacheWrite: number; output: number };

export type VoiceSettings = {
  enabled: boolean;
  channelId: string;
  textChannelId: string;
  liveModel: string;
  backendModel: string;
  summaryModel: string;
  voice: string;
  backendReasoning: string;
  apiKeyEnv: string;
  instructions: string;
  timeZone: string;
  dailyMinuteCap: number;
  totalMinuteCap: number;
  backendUsdCap: number;
  idleCloseSec: number;
  wakeRmsDbfs: number;
  webSearchUsdPerCall: number;
  prices: Record<string, TokenPrices>;
};

/** Voice has no implicit model, channel, credentials or pricing. Enabling it is an explicit cost decision. */
export const voiceSettings = (raw: Partial<VoiceSettings> | undefined): VoiceSettings => {
  if (raw?.enabled !== true) throw new Error("Discord voice is disabled; set voice.enabled=true explicitly");
  const value = {
    backendReasoning: "low",
    apiKeyEnv: "OPENAI_API_KEY",
    instructions: "",
    timeZone: "UTC",
    dailyMinuteCap: 30,
    totalMinuteCap: 0,
    backendUsdCap: 3,
    idleCloseSec: 120,
    wakeRmsDbfs: -45,
    ...raw,
  };
  for (const name of ["channelId", "textChannelId", "liveModel", "backendModel", "summaryModel", "voice"] as const) {
    if (typeof value[name] !== "string" || !value[name]?.trim()) throw new Error(`voice.${name} is required`);
  }
  for (const name of ["channelId", "textChannelId"] as const) {
    if (!isDiscordSnowflake(value[name])) throw new Error(`voice.${name} must be a Discord channel ID`);
  }
  for (const name of ["dailyMinuteCap", "backendUsdCap", "idleCloseSec"] as const) {
    if (!Number.isFinite(value[name]) || value[name] <= 0) throw new Error(`voice.${name} must be positive`);
  }
  for (const name of ["totalMinuteCap", "webSearchUsdPerCall"] as const) {
    if (typeof value[name] !== "number" || !Number.isFinite(value[name]) || value[name]! < 0)
      throw new Error(`voice.${name} must be a nonnegative number`);
  }
  if (!Number.isFinite(value.wakeRmsDbfs) || value.wakeRmsDbfs >= 0 || value.wakeRmsDbfs < -120)
    throw new Error("voice.wakeRmsDbfs must be between -120 and 0 (exclusive)");
  if (typeof value.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv))
    throw new Error("voice.apiKeyEnv must name an environment variable");
  if (typeof value.instructions !== "string" || typeof value.backendReasoning !== "string")
    throw new Error("voice.instructions and voice.backendReasoning must be strings");
  if (typeof value.timeZone !== "string") throw new Error("voice.timeZone must be an IANA time zone");
  new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format();
  for (const model of [value.backendModel!, value.summaryModel!]) {
    const prices = value.prices?.[model];
    for (const name of ["input", "cached", "cacheWrite", "output"] as const) {
      if (!prices || typeof prices[name] !== "number" || !Number.isFinite(prices[name]) || prices[name] < 0)
        throw new Error(
          `voice.prices[${JSON.stringify(model)}].${name} must be a nonnegative price per million tokens`,
        );
    }
  }
  return value as VoiceSettings;
};
