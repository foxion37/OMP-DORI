import { inboundProtocolError, type Request, unavailable } from "./discord-inbound-api.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";

export type ChannelInfo = { guild?: string; type?: number; parent?: string };
const THREAD_CHANNELS = new Set([10, 11, 12]);

/** Only Discord thread types make parent_id a thread parent, rather than a category. */
export const channelInfo = async (
  request: Request,
  channelId: string,
  optional: boolean,
  signal?: AbortSignal,
): Promise<ChannelInfo | undefined> => {
  let value: unknown;
  try {
    value = await request<unknown>(`/channels/${channelId}`, undefined, signal);
    signal?.throwIfAborted();
  } catch (error) {
    if (optional && unavailable(error)) return undefined;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inboundProtocolError("Discord inbound channel response is invalid");
  }
  const { guild_id, parent_id, type } = value as Record<string, unknown>;
  const thread = typeof type === "number" && THREAD_CHANNELS.has(type);
  return {
    ...(isDiscordSnowflake(guild_id) ? { guild: guild_id } : {}),
    ...(typeof type === "number" ? { type } : {}),
    ...(thread && isDiscordSnowflake(parent_id) ? { parent: parent_id } : {}),
  };
};

/** Active listing failures are optional discovery failures, not explicit-target authorization. */
export const activeThreads = async (
  request: Request,
  guildId: string,
): Promise<{ id: string; parent: string }[] | undefined> => {
  let value: unknown;
  try {
    value = await request<unknown>(`/guilds/${guildId}/threads/active`);
  } catch (error) {
    if (unavailable(error)) return undefined;
    throw error;
  }
  const threads: unknown = (value as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(threads)) throw inboundProtocolError("Discord inbound thread response is invalid");
  const found: { id: string; parent: string }[] = [];
  for (const thread of threads) {
    if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
      throw inboundProtocolError("Discord inbound thread response is invalid");
    }
    const { id, parent_id } = thread as Record<string, unknown>;
    if (isDiscordSnowflake(id) && isDiscordSnowflake(parent_id)) found.push({ id, parent: parent_id });
  }
  return found;
};
