import type { Clock } from "../run.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";
import {
  confirmedReply,
  discordResponse,
  incompleteReplyReceipt,
  type PostedMessage,
  responseId,
  retryAfter,
} from "./discord-response.ts";
import { DEFAULT_RETRY, guardText, type Http, MessengerError, withBackoff } from "./http.ts";
import { DISCORD_LIMIT, splitForDiscord } from "./split.ts";

export type DcChannel = {
  readonly id: string;
  readonly type: number;
  readonly name?: string;
  readonly topic?: string | null;
  readonly parent_id?: string | null;
  readonly available_tags?: readonly { readonly id: string; readonly name: string }[];
};

type Delivery = { readonly ids: string[]; readonly replyConfirmed: boolean };

/** Forum and media channels contain posts, each represented by a thread. */
export const isForumType = (type: number): boolean => type === 15 || type === 16;

/**
 * An environment-supplied REST API prefix may target only loopback HTTP.
 * Credentials and query/fragment components are not usable API prefixes.
 */
export function discordApiBase(value: string | undefined): string {
  const fallback = "https://discord.com/api/v10";
  if (value === undefined || value === "") return fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MessengerError("DORI_DISCORD_API_BASE is not a URL", 0);
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.href !== url.origin + url.pathname
  )
    throw new MessengerError(
      "DORI_DISCORD_API_BASE must use a loopback http origin without credentials, query or fragment",
      0,
    );
  return url.href.replace(/\/+$/, "");
}

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = discordApiBase(process.env["DORI_DISCORD_API_BASE"]),
  ) {}

  async call<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const operation = `discord ${method} ${path}`;
    const res = await withBackoff(
      this.http,
      this.clock,
      {
        method,
        operation,
        url: `${this.base}${path}`,
        headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(signal === undefined ? {} : { signal }),
      },
      // Cancellable live metadata owns its existing 2s–30s retry outside this single HTTP attempt.
      signal === undefined ? undefined : { ...DEFAULT_RETRY, attempts: 1 },
      retryAfter,
    );
    return discordResponse<T>(res, method, operation);
  }

  /**
   * Posts the text as consecutive messages of at most 2000 characters (`splitForDiscord`) and returns their IDs in
   * order. `replyTo` binds the first message to the same physical channel and pings nobody. A missing target fails
   * instead of posting unlinked. A failed part stops the rest; its error names the parts already posted, which stay.
   */
  async send(channelId: string, content: string, opts: { readonly replyTo?: string } = {}): Promise<string[]> {
    return (await this.sendDelivery(channelId, content, opts)).ids;
  }

  /** Preserve first-message reply evidence instead of inferring it from the request. */
  async sendDelivery(channelId: string, content: string, opts: { readonly replyTo?: string } = {}): Promise<Delivery> {
    return await this.post(channelId, splitForDiscord(guardText(content)), opts.replyTo);
  }

  /** `before`: messages of the same text already posted (a forum starter), counted in a failure's part numbers. */
  private async post(
    channelId: string,
    parts: readonly string[],
    replyTo?: string,
    before: readonly string[] = [],
  ): Promise<Delivery> {
    const ids: string[] = [...before];
    const total = before.length + parts.length;
    const path = `/channels/${channelId}/messages`;
    const operation = `discord POST ${path}`;
    let replyConfirmed = false;
    for (const [index, part] of parts.entries()) {
      const reply = before.length === 0 && index === 0 ? replyTo : undefined;
      try {
        const sent = await this.call<PostedMessage | null>("POST", path, {
          content: part,
          allowed_mentions: { parse: [] },
          ...(reply === undefined
            ? {}
            : { message_reference: { message_id: reply, channel_id: channelId, fail_if_not_exists: true } }),
        });
        if (reply !== undefined) replyConfirmed = confirmedReply(sent, channelId, reply);
        // A parsed reply response can lack proof. Retain the other part IDs without retrying it or settling the owe.
        if (replyTo === undefined || sent === null || typeof sent !== "object" || Array.isArray(sent)) {
          ids.push(responseId(sent, operation));
        } else if (isDiscordSnowflake(sent.id)) ids.push(sent.id);
      } catch (e) {
        const position = `part ${before.length + index + 1} of ${total}`;
        const why = e instanceof MessengerError ? e.message : `${operation} failed`;
        const status = e instanceof MessengerError ? e.status : 0;
        if (ids.length < before.length + index) {
          throw incompleteReplyReceipt(ids, { status, detail: `${position} stopped: ${why}` });
        }
        if (ids.length === 0) throw e;
        throw new MessengerError(
          `${why} (${position}; already posted: ${ids.join(" ")})`,
          status,
          e instanceof MessengerError ? e.code : undefined,
          e instanceof MessengerError ? e.outcome : "uncertain",
        );
      }
    }
    if (ids.length !== total) throw incompleteReplyReceipt(ids);
    return { ids, replyConfirmed };
  }

  /** One message is edited in place: text over the limit is refused before any request, never split. */
  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    const guarded = guardText(content);
    if (guarded.length > DISCORD_LIMIT)
      throw new MessengerError(
        `discord edit: text exceeds ${DISCORD_LIMIT} UTF-16 code units; shorten the text or send without --edit`,
        400,
      );
    const path = `/channels/${channelId}/messages/${messageId}`;
    responseId(await this.call("PATCH", path, { content: guarded }), `discord PATCH ${path}`);
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async startThread(channelId: string, messageId: string, name: string): Promise<string> {
    const path = `/channels/${channelId}/messages/${messageId}/threads`;
    const thread = await this.call("POST", path, { name: guardText(name).slice(0, 100) });
    return responseId(thread, `discord POST ${path}`);
  }

  async setThread(
    threadId: string,
    patch: { readonly name?: string; readonly archived?: boolean; readonly appliedTags?: readonly string[] },
  ): Promise<string> {
    const path = `/channels/${threadId}`;
    const thread = await this.call("PATCH", path, {
      ...(patch.name ? { name: guardText(patch.name).slice(0, 100) } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.appliedTags !== undefined ? { applied_tags: patch.appliedTags } : {}),
    });
    return responseId(thread, `discord PATCH ${path}`);
  }

  /** Forum posts include a starter message; text-channel threads optionally receive one after creation. */
  async createThread(
    channel: DcChannel,
    name: string,
    opts: { readonly text?: string; readonly appliedTags?: readonly string[] } = {},
  ): Promise<{ readonly id: string; readonly messageId?: string }> {
    const title = guardText(name).slice(0, 100);
    const text = opts.text === undefined ? undefined : guardText(opts.text);
    const path = `/channels/${channel.id}/threads`;
    if (isForumType(channel.type)) {
      // The starter message holds the first part; longer text continues as messages in the new post.
      const [starter = "", ...more] = splitForDiscord(text ?? name);
      const thread = await this.call<{ id: string; message?: { id: string } }>("POST", path, {
        name: title,
        message: { content: starter, allowed_mentions: { parse: [] } },
        ...(opts.appliedTags !== undefined ? { applied_tags: opts.appliedTags } : {}),
      });
      const id = responseId(thread, `discord POST ${path}`);
      const messageId =
        thread.message === undefined ? undefined : responseId(thread.message, `discord forum starter ${id}`);
      if (more.length > 0) await this.post(id, more, undefined, messageId === undefined ? [] : [messageId]);
      return messageId === undefined ? { id } : { id, messageId };
    }
    const id = responseId(await this.call("POST", path, { name: title, type: 11 }), `discord POST ${path}`);
    return text === undefined ? { id } : { id, ...(await this.firstOf(id, text)) };
  }

  /** A thread on an existing message, then optional text inside it. */
  async threadOnMessage(
    channelId: string,
    messageId: string,
    name: string,
    text?: string,
  ): Promise<{ readonly id: string; readonly messageId?: string }> {
    const guarded = text === undefined ? undefined : guardText(text);
    const id = await this.startThread(channelId, messageId, name);
    return guarded === undefined ? { id } : { id, ...(await this.firstOf(id, guarded)) };
  }

  /** Sends text into a new thread and names its first message, the one a `mid=` refers to. */
  private async firstOf(threadId: string, text: string): Promise<{ readonly messageId?: string }> {
    const [first] = await this.send(threadId, text);
    return first === undefined ? {} : { messageId: first };
  }

  /** Add or remove the bot's own reaction, using Discord's URL-encoded emoji route. */
  async react(channelId: string, messageId: string, emoji: string, remove = false): Promise<void> {
    await this.call(
      remove ? "DELETE" : "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }

  channel(id: string): Promise<DcChannel> {
    return this.call<DcChannel>("GET", `/channels/${id}`);
  }

  guildChannels(guildId: string): Promise<readonly DcChannel[]> {
    return this.call<readonly DcChannel[]>("GET", `/guilds/${guildId}/channels`);
  }
}
