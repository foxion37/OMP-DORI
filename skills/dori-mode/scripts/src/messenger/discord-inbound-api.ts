import type { Discord } from "./discord.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";
import { MessengerError } from "./http.ts";

export type Message = {
  id: string;
  channel_id: string;
  type?: number;
  author?: { id?: string; bot?: boolean; system?: boolean };
  webhook_id?: string;
  content?: string;
  flags?: number;
  attachments?: unknown;
  message_reference?: { message_id?: string };
  /** Present on replies, or null when Discord could not load the target (for example, after deletion). */
  referenced_message?: { id?: string; author?: { id?: string }; content?: string } | null;
};
/** One owner attachment, retaining Discord field names and the exact expiring signed CDN URL. */
type InboundAttachment = {
  filename: string;
  content_type?: string;
  size: number;
  url: string;
  /** Set by the message's IS_VOICE_MESSAGE flag. */
  voice?: true;
  duration_secs?: number;
};
/** Reply context is data; compare the author ID with the owner and bot IDs from INBOUND_READY. */
type InboundReply = { id: string; author: string; text: string };
export type DiscordInbound = {
  channel: string;
  message: string;
  reference: string | null;
  text: string;
  replyTo: InboundReply | null;
  attachments: InboundAttachment[];
};
export type Request = <T>(path: string, body?: Record<string, unknown>) => Promise<T>;

const REQUEST_FAILED = "Discord inbound request failed; check the connection and Discord API availability";

/** A locally detected response fault; retrying it must not hold the live queue indefinitely. */
export const inboundProtocolError = (message: string): MessengerError =>
  new MessengerError(message, 502, "DISCORD_INBOUND_PROTOCOL_ERROR");

/** A rate limit, a server error or an unreachable API: worth retrying; anything else needs the operator. */
export const isTransient = (error: unknown): boolean =>
  error instanceof MessengerError &&
  error.code !== "DISCORD_INBOUND_PROTOCOL_ERROR" &&
  (error.status === 429 ||
    error.status >= 500 ||
    (error.status === 0 && error.code === "DISCORD_INBOUND_REQUEST_FAILED"));

/** Maps Discord failures to actionable errors that never echo a response body. */
export const inboundRequest =
  (discord: Discord): Request =>
  async <T>(path: string, body?: Record<string, unknown>): Promise<T> => {
    try {
      return await discord.call<T>(body ? "POST" : "GET", path, body);
    } catch (error) {
      if (error instanceof SyntaxError) throw inboundProtocolError("Discord inbound response is invalid");
      const status = error instanceof MessengerError ? error.status : 0;
      let message = REQUEST_FAILED;
      if (status === 401)
        message = "Discord inbound authentication failed; set DORI_DISCORD_TOKEN to a valid bot token";
      else if (status === 403) {
        message =
          "Discord inbound access denied; grant View Channel, Read Message History and access to the configured thread";
      } else if (status === 404) {
        message =
          "Discord inbound channel is unavailable; check DORI_DISCORD_CHANNEL_ID, DORI_DISCORD_CHANNEL_IDS and the bot's channel access";
      } else if (status === 429)
        message = "Discord inbound remains rate limited after retries; reduce the polling frequency";
      throw new MessengerError(message, status, status === 0 ? "DISCORD_INBOUND_REQUEST_FAILED" : undefined);
    }
  };

export const messagePage = async (
  request: Request,
  channelId: string,
  limit: number,
  before?: string,
): Promise<readonly Message[]> => {
  const value = await request<unknown>(
    `/channels/${channelId}/messages?limit=${limit}${before === undefined ? "" : `&before=${before}`}`,
  );
  if (!Array.isArray(value) || value.length > limit) {
    throw inboundProtocolError("Discord inbound message response is invalid");
  }
  const messages = value as Message[];
  for (const message of messages) {
    if (!message || typeof message !== "object" || !isDiscordSnowflake(message.id)) {
      throw inboundProtocolError("Discord inbound message response is invalid");
    }
  }
  return messages;
};

/** An owner message or reply, with or without text: not the bot itself, another bot, a webhook, or a system message. */
export const isOwnerMessage = (message: Message, ownerId: string, botId: string): boolean =>
  message.author?.id === ownerId &&
  message.author.id !== botId &&
  !message.author.bot &&
  !message.author.system &&
  !message.webhook_id &&
  (message.type === 0 || message.type === 19);

export const toInbound = (message: Message): DiscordInbound => {
  if (typeof message.content !== "string") {
    throw new MessengerError(
      "Discord inbound owner message content is unavailable; enable Message Content Intent",
      403,
    );
  }
  const reference = message.message_reference?.message_id;
  const replied = message.referenced_message;
  return {
    channel: message.channel_id,
    message: message.id,
    reference: isDiscordSnowflake(reference) ? reference : null,
    text: message.content,
    replyTo:
      replied && isDiscordSnowflake(replied.id) && isDiscordSnowflake(replied.author?.id)
        ? {
            id: replied.id,
            author: replied.author.id,
            text: typeof replied.content === "string" ? replied.content : "",
          }
        : null,
    attachments: toAttachments(message),
  };
};

const IS_VOICE_MESSAGE = 1 << 13;

const toAttachments = (message: Message): InboundAttachment[] => {
  const list = message.attachments === undefined ? [] : message.attachments;
  if (!Array.isArray(list)) throw inboundProtocolError("Discord inbound attachment list is invalid");
  const voice = typeof message.flags === "number" && (message.flags & IS_VOICE_MESSAGE) !== 0;
  return list.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw inboundProtocolError("Discord inbound attachment is invalid");
    }
    const { filename, content_type, size, url, duration_secs } = value as Record<string, unknown>;
    if (typeof filename !== "string" || typeof url !== "string" || !Number.isSafeInteger(size)) {
      throw inboundProtocolError("Discord inbound attachment is invalid");
    }
    return {
      filename,
      ...(typeof content_type === "string" ? { content_type } : {}),
      size: size as number,
      url,
      ...(voice ? { voice: true as const } : {}),
      ...(typeof duration_secs === "number" ? { duration_secs } : {}),
    };
  });
};

const TEXT_CHANNELS = new Set([0, 5]); // text and announcement

/** Every text channel and active thread in the bot's guilds, plus the owner's DM with the bot. */
export const discoverChannels = async (request: Request, ownerId: string): Promise<string[]> => {
  const ids = new Set<string>();
  const guilds = await request<{ id?: string }[]>("/users/@me/guilds");
  for (const guild of Array.isArray(guilds) ? guilds : []) {
    if (!isDiscordSnowflake(guild?.id)) continue;
    const channels = await request<{ id?: string; type?: number }[]>(`/guilds/${guild.id}/channels`);
    for (const channel of Array.isArray(channels) ? channels : []) {
      if (isDiscordSnowflake(channel?.id) && TEXT_CHANNELS.has(channel.type ?? -1)) ids.add(channel.id);
    }
    const threads = await request<{ threads?: { id?: string }[] }>(`/guilds/${guild.id}/threads/active`);
    for (const thread of Array.isArray(threads?.threads) ? threads.threads : []) {
      if (isDiscordSnowflake(thread?.id)) ids.add(thread.id);
    }
  }
  try {
    const dm = await request<{ id?: string }>("/users/@me/channels", { recipient_id: ownerId });
    if (isDiscordSnowflake(dm?.id)) ids.add(dm.id);
  } catch (error) {
    if (!(error instanceof MessengerError) || (error.status !== 403 && error.status !== 404)) throw error;
  }
  return [...ids];
};
