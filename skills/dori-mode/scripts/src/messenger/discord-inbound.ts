import type { Discord } from "./discord.ts";
import type { InboundContext } from "./discord-channels.ts";
import {
  type DiscordInbound,
  discoverChannels,
  type Emit,
  inboundProtocolError,
  inboundRequest,
  isOwnerMessage,
  type Message,
  messagePage,
  newer,
  toInbound,
  unavailable,
} from "./discord-inbound-api.ts";
import type { DiscordInboundQueue } from "./discord-inbound-queue.ts";
import { discordInboundEnv, type DiscordInboundStore, isDiscordSnowflake } from "./discord-inbound-state.ts";
import { discordThreadPoll } from "./discord-inbound-thread-poll.ts";
import { discordThreads } from "./discord-inbound-threads.ts";
import { MessengerError } from "./http.ts";

export type { DiscordInbound } from "./discord-inbound-api.ts";
export type DiscordInboundOptions = {
  ownerId: string;
  /** Explicit IDs remain strict, including configured threads without a watched parent. */
  channelIds: readonly string[];
  all?: boolean;
  /** Active children of configured parents are followed unless explicitly disabled. */
  threads?: boolean;
};

/** Failure to add a read receipt must not replay the owner's request. */
export async function markDiscordInboundSeen(
  discord: Pick<Discord, "react">,
  message: Pick<DiscordInbound, "channel" | "message">,
): Promise<void> {
  try {
    await discord.react(message.channel, message.message, "👀");
  } catch {
    console.error(`Discord read receipt failed for ${message.channel}/${message.message}`);
  }
}

export const formatDiscordInbound = (message: DiscordInbound): string => {
  const id = `discord ${message.channel} ${message.message}`;
  return [
    `INBOUND ${id} from=owner ref=${message.reference ?? "-"} ${JSON.stringify(message.text)}`,
    ...(message.replyTo ? [`INBOUND_REPLY ${id} ${JSON.stringify(message.replyTo)}`] : []),
    ...message.attachments.map((attachment) => `INBOUND_ATTACHMENT ${id} ${JSON.stringify(attachment)}`),
  ].join("\n");
};

export const formatInboundContext = (message: DiscordInbound, context: InboundContext): string =>
  `INBOUND_CONTEXT discord ${message.channel} ${message.message} ${JSON.stringify(context)}`;

/**
 * Known REST and admitted owners merge before each delivery boundary. An older frame admitted during an
 * awaited emit may arrive late, never checkpoint backwards. Emit/crash windows may repeat a request.
 */
export const discordInbound = async (
  discord: Discord,
  storeFor: (channelId: string, seed?: boolean) => DiscordInboundStore,
  opts: DiscordInboundOptions,
) => {
  const ownerId = discordInboundEnv("DORI_DISCORD_OWNER_ID", opts.ownerId);
  const explicit = opts.channelIds.map((id) => discordInboundEnv("DORI_DISCORD_CHANNEL_IDS", id));
  const request = inboundRequest(discord);
  const me = await request<{ id?: string; bot?: boolean }>("/users/@me");
  if (me?.bot !== true || !isDiscordSnowflake(me.id)) {
    throw new MessengerError("Discord inbound requires an authenticated bot identity; use a bot token", 401);
  }
  const botId = me.id;
  if (botId === ownerId)
    throw new MessengerError("DORI_DISCORD_OWNER_ID must identify the human owner, not the bot", 0);
  const application = await request<{ flags?: number }>("/applications/@me");
  const flags = application?.flags;
  if (typeof flags !== "number" || !Number.isSafeInteger(flags) || (flags & ((1 << 18) | (1 << 19))) === 0) {
    throw new MessengerError(
      "Discord inbound needs Message Content Intent enabled for this bot in the Developer Portal",
      403,
    );
  }
  const watched = new Map<string, DiscordInboundStore>();
  const parents = new Map<string, string>();
  const threads = opts.threads !== false && !opts.all;
  const current = (store: DiscordInboundStore): string => {
    const cursor = store.load();
    if (cursor === undefined)
      throw new MessengerError("Discord inbound cursor disappeared; restore its state before retrying", 0);
    return cursor;
  };
  const readPage = async (channel: string, limit: number, before?: string) => {
    try {
      return await messagePage(request, channel, limit, before);
    } catch (error) {
      if (explicit.includes(channel) || !unavailable(error)) throw error;
      watched.delete(channel);
      return undefined;
    }
  };
  const attach = async (channel: string, seed?: string): Promise<string | undefined> => {
    const store = storeFor(channel);
    const cursor = store.load();
    const latest = await readPage(channel, 1);
    if (latest === undefined) return undefined;
    if (latest.some((message) => message.channel_id !== channel)) {
      throw inboundProtocolError("Discord inbound channel response does not match the configured channel");
    }
    if (cursor === undefined) store.save(seed ?? latest[0]?.id ?? "0");
    watched.set(channel, store);
    return latest[0]?.id ?? "0";
  };
  const following = discordThreads({ request, explicit, watched, parents, attach });
  const refresh = async (initial: boolean): Promise<void> => {
    for (const id of explicit) {
      if (watched.has(id)) continue;
      const latest = await attach(id);
      if (latest !== undefined && threads) {
        const position = current(watched.get(id)!);
        await following.register(id, newer(latest, position) ? latest : position);
      }
    }
    if (opts.all) {
      for (const id of await discoverChannels(request, ownerId)) if (!watched.has(id)) await attach(id);
    }
    if (threads) await following.follow(initial);
  };
  const valid = (message: Message): boolean =>
    !!message && isDiscordSnowflake(message.id) && isDiscordSnowflake(message.channel_id);
  const parentFor = (channel: string): string | undefined =>
    threads ? (following.cached(channel) ?? undefined) : undefined;
  const accepts = (message: Message, parent?: string | null): boolean =>
    valid(message) &&
    (opts.all === true || watched.has(message.channel_id) || (threads && parent != null && parents.has(parent)));
  const adoptThread = (channel: string, parent: string): string => {
    if (!threads || !parents.has(parent)) throw inboundProtocolError("Discord inbound thread scope is invalid");
    const floor = following.adopt(channel, parent);
    const store = storeFor(channel, false);
    if (store.load() === undefined) store.save(floor);
    watched.set(channel, store);
    return floor;
  };
  const deliver = async (message: Message, store: DiscordInboundStore, emit: Emit, cursor = message.id) => {
    if (isOwnerMessage(message, ownerId, botId)) await emit(toInbound(message));
    store.save(cursor);
  };
  const accept = async (
    message: Message,
    emit: Emit,
    admittedAfter?: string | null,
    parent?: string | null,
  ): Promise<void> => {
    if (!valid(message)) return;
    if (!accepts(message, parent)) {
      if (admittedAfter !== undefined || !threads) return;
      const found = await following.parentOf(message.channel_id);
      if (found === undefined) return;
      adoptThread(message.channel_id, found);
    }
    if (admittedAfter !== undefined && admittedAfter !== null && admittedAfter !== "0")
      discordInboundEnv("Discord inbound queue admission cursor", admittedAfter);
    let store = watched.get(message.channel_id);
    if (!store) {
      store = storeFor(message.channel_id);
      if (store.load() === undefined) store.save(admittedAfter ?? String(BigInt(message.id) - 1n));
      // An archived admitted record is delivery work, not a reason to resume polling that thread.
      if (parent == null || explicit.includes(message.channel_id)) watched.set(message.channel_id, store);
    }
    const cursor = current(store);
    if (
      !newer(message.id, cursor) &&
      (admittedAfter === undefined ||
        message.id === cursor ||
        (admittedAfter !== null && !newer(message.id, admittedAfter)) ||
        !isOwnerMessage(message, ownerId, botId))
    )
      return;
    await deliver(message, store, emit, newer(message.id, cursor) ? message.id : cursor);
  };
  const pollChannel = discordThreadPoll({ ownerId, botId, current, readPage, valid, accepts, accept, deliver });
  await refresh(true);
  let polls = 0;
  return {
    botId,
    accepts,
    parentFor,
    adoptThread,
    needsThread(message: Message): boolean {
      return (
        valid(message) &&
        threads &&
        parents.size > 0 &&
        !accepts(message) &&
        following.cached(message.channel_id) !== null
      );
    },
    resolveThread: (channel: string, signal: AbortSignal) => following.parentOf(channel, signal),
    cursorFor(channel: string): string | undefined {
      const store = watched.get(channel);
      return store ? current(store) : storeFor(channel, false).load();
    },
    channels: (): string[] => [...watched.keys()],
    async poll(emit: Emit, queue?: DiscordInboundQueue, scoped?: () => void): Promise<void> {
      if (opts.all ? ++polls % 100 === 0 : threads && ++polls % 10 === 0) await refresh(false);
      scoped?.();
      for (const [channel, store] of [...watched]) await pollChannel(channel, store, emit, queue);
    },
    async sync(emit: Emit, queue?: DiscordInboundQueue, scoped?: () => void): Promise<void> {
      await refresh(false);
      scoped?.();
      if (queue) {
        for (let channel = queue.nextChannel(""); channel !== undefined; channel = queue.nextChannel(channel)) {
          if (watched.has(channel)) continue;
          if (opts.all) await attach(channel);
          else {
            const parent = queue.parentFor(channel);
            if (threads && parent !== undefined && parents.has(parent))
              await pollChannel(channel, storeFor(channel), emit, queue);
          }
        }
      }
      await this.poll(emit, queue, scoped);
    },
    accept,
  };
};
