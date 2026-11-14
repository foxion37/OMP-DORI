import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export type DcChannel = {
  readonly id: string;
  readonly type: number;
  readonly name?: string;
  readonly parent_id?: string | null;
  readonly available_tags?: readonly { readonly id: string; readonly name: string }[];
};

/** Forum and media channels contain posts, each represented by a thread. */
export const isForumType = (type: number): boolean => type === 15 || type === 16;

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://discord.com/api/v10",
  ) {}

  async call<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await withBackoff(
      this.http,
      this.clock,
      {
        method,
        url: `${this.base}${path}`,
        headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      undefined,
      retryAfter,
    );
    if (res.status >= 300)
      throw new MessengerError(`discord ${method} ${path}: ${res.status} ${res.body.slice(0, 160)}`, res.status);
    return (res.body ? JSON.parse(res.body) : {}) as T;
  }

  async send(channelId: string, content: string): Promise<string> {
    return (
      await this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, {
        content: guardText(content),
        allowed_mentions: { parse: [] },
      })
    ).id;
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: guardText(content) });
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async startThread(channelId: string, messageId: string, name: string): Promise<string> {
    return (
      await this.call<{ id: string }>("POST", `/channels/${channelId}/messages/${messageId}/threads`, {
        name: guardText(name).slice(0, 100),
      })
    ).id;
  }

  async setThread(
    threadId: string,
    patch: { readonly name?: string; readonly archived?: boolean; readonly appliedTags?: readonly string[] },
  ): Promise<string> {
    return (
      await this.call<{ id: string }>("PATCH", `/channels/${threadId}`, {
        ...(patch.name ? { name: guardText(patch.name).slice(0, 100) } : {}),
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
        ...(patch.appliedTags !== undefined ? { applied_tags: patch.appliedTags } : {}),
      })
    ).id;
  }

  /** Forum posts include a starter message; text-channel threads optionally receive one after creation. */
  async createThread(
    channel: DcChannel,
    name: string,
    opts: { readonly text?: string; readonly appliedTags?: readonly string[] } = {},
  ): Promise<{ readonly id: string; readonly messageId?: string }> {
    const title = guardText(name).slice(0, 100);
    const text = opts.text === undefined ? undefined : guardText(opts.text);
    if (isForumType(channel.type)) {
      const thread = await this.call<{ id: string; message?: { id: string } }>(
        "POST",
        `/channels/${channel.id}/threads`,
        {
          name: title,
          message: { content: text ?? name, allowed_mentions: { parse: [] } },
          ...(opts.appliedTags !== undefined ? { applied_tags: opts.appliedTags } : {}),
        },
      );
      return { id: thread.id, ...(thread.message === undefined ? {} : { messageId: thread.message.id }) };
    }
    const thread = await this.call<{ id: string }>("POST", `/channels/${channel.id}/threads`, {
      name: title,
      type: 11,
    });
    return text === undefined ? { id: thread.id } : { id: thread.id, messageId: await this.send(thread.id, text) };
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
