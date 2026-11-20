import type { DiscordGatewayAdapterLibraryMethods } from "@discordjs/voice";
import type { VoiceDispatch } from "./discord-link.ts";

type ServerUpdate = Parameters<DiscordGatewayAdapterLibraryMethods["onVoiceServerUpdate"]>[0];
type StateUpdate = Parameters<DiscordGatewayAdapterLibraryMethods["onVoiceStateUpdate"]>[0];

const string = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Invalid Discord voice string field");
  return value;
};
const nullable = (value: unknown): string | null => (value === null ? null : string(value));
const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("Invalid Discord voice boolean field");
  return value;
};

/** Validate the library's actual dispatch schema, not a double cast from a generic Gateway object. */
export const voiceServerUpdate = (data: VoiceDispatch): ServerUpdate => ({
  guild_id: string(data["guild_id"]),
  token: string(data["token"]),
  endpoint: nullable(data["endpoint"]),
});
export const voiceStateUpdate = (data: VoiceDispatch): StateUpdate => ({
  guild_id: string(data["guild_id"]),
  user_id: string(data["user_id"]),
  session_id: string(data["session_id"]),
  channel_id: nullable(data["channel_id"]),
  deaf: boolean(data["deaf"]),
  mute: boolean(data["mute"]),
  self_deaf: boolean(data["self_deaf"]),
  self_mute: boolean(data["self_mute"]),
  self_video: boolean(data["self_video"]),
  suppress: boolean(data["suppress"]),
  request_to_speak_timestamp: nullable(data["request_to_speak_timestamp"]),
  ...(data["self_stream"] === undefined ? {} : { self_stream: boolean(data["self_stream"]) }),
});
