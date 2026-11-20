import { Discord } from "../src/messenger/discord.ts";
import type { DiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { fakeClock } from "./fakes.ts";

export type TestDiscordMessage = {
  id: string;
  channel_id: string;
  type: number;
  author: { id: string; bot?: boolean; system?: boolean };
  content?: string;
  webhook_id?: string;
  message_reference?: { message_id?: string; type?: number };
  referenced_message?: { id: string; author: { id: string }; content: string } | null;
  flags?: number;
  attachments?: unknown;
};
export const ownerMessage = (id: string, patch: Partial<TestDiscordMessage> = {}): TestDiscordMessage => ({
  id,
  channel_id: "20",
  type: 0,
  author: { id: "10" },
  content: `owner ${id}`,
  ...patch,
});

export const memoryDiscordCursor = (initial?: string) => {
  let cursor = initial;
  const saved: string[] = [];
  const store: DiscordInboundStore = {
    load: () => cursor,
    save: (value) => {
      cursor = value;
      saved.push(value);
    },
  };
  return { store, saved };
};

/** Stateful history and authenticated REST endpoints, including overlapping/failed history pages. */
export const discordRestWorld = (messages: TestDiscordMessage[] = []) => {
  const state = {
    messages,
    bot: true,
    botId: "99",
    flags: 1 << 19,
    failBefore: false,
    overlap: false,
    stuckBefore: false,
    failure: new Map<string, number>(),
    retryAfter: new Map<string, string>(),
    responses: new Map<string, string>(),
    unreachable: new Set<string>(),
    blocked: new Map<string, Promise<void>>(),
    unrelated: [] as TestDiscordMessage[],
    /** Guild text channels, active threads and the owner DM, for scope=all discovery. */
    guilds: [] as { id: string; channels: string[]; threads: string[] }[],
    /** Thread id to parent channel id; a thread listed under a guild without an entry has no known parent. */
    threadParents: new Map<string, string>(),
    /** Channel id to guild id, for channel metadata and thread-parent lookups. */
    channelGuilds: new Map<string, string>(),
    /** Channel id to category id: a text channel's `parent_id` names its category, not a thread parent. */
    categoryParents: new Map<string, string>(),
    dm: undefined as string | undefined,
    denied: new Set<string>(),
    mixChannels: false,
    aborted: [] as string[],
  };
  const requests: HttpRequest[] = [];
  const http: Http = async (request) => {
    requests.push(request);
    const url = new URL(request.url);
    const path = url.pathname.slice("/api/v10".length);
    const status = state.failure.get(path);
    const retryAfter = state.retryAfter.get(path);
    if (status) {
      return {
        status,
        headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
        body: '{"diagnostic":"private unrelated server body"}',
      };
    }
    if (request.headers?.["Authorization"] !== "Bot unit-private-token") {
      return { status: 401, headers: {}, body: '{"diagnostic":"private authentication body"}' };
    }
    const blocked = state.blocked.get(path);
    if (blocked && request.signal) {
      const signal = request.signal;
      signal.throwIfAborted();
      const gate = Promise.withResolvers<void>();
      const abort = () => {
        state.aborted.push(path);
        gate.reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      void blocked.then(gate.resolve, gate.reject);
      try {
        await gate.promise;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } else await blocked;
    if (state.unreachable.has(path)) throw new TypeError("private transport diagnostic");
    const response = state.responses.get(path + url.search) ?? state.responses.get(path);
    if (response !== undefined) return { status: 200, headers: {}, body: response };
    let body: unknown;
    if (path === "/users/@me") body = { id: state.botId, bot: state.bot };
    else if (path === "/applications/@me") body = { flags: state.flags };
    else if (path === "/users/@me/guilds") body = state.guilds.map((guild) => ({ id: guild.id }));
    else if (path === "/users/@me/channels") {
      if (request.method !== "POST" || JSON.parse(String(request.body ?? "{}")).recipient_id !== "10") {
        throw new Error("unexpected DM request");
      }
      body = { id: state.dm };
    } else if (/^\/guilds\/\d+\/channels$/.test(path)) {
      body = (state.guilds.find((guild) => path.includes(`/${guild.id}/`))?.channels ?? []).map((id) => ({
        id,
        type: 0,
      }));
    } else if (/^\/guilds\/\d+\/threads\/active$/.test(path)) {
      const guild = state.guilds.find((guild) => path.includes(`/${guild.id}/`));
      body = {
        threads: (guild?.threads ?? []).map((id) => ({
          id,
          parent_id: state.threadParents.get(id) ?? "0",
        })),
      };
    } else if (/^\/channels\/\d+$/.test(path)) {
      const channel = path.split("/")[2] ?? "";
      if (state.denied.has(channel)) return { status: 403, headers: {}, body: "{}" };
      const guild = state.channelGuilds.get(channel) ?? state.guilds.find((g) => g.channels.includes(channel))?.id;
      body = {
        ...(guild === undefined ? {} : { guild_id: guild }),
        type: state.threadParents.has(channel) ? 11 : 0,
        ...((state.threadParents.get(channel) ?? state.categoryParents.get(channel)) === undefined
          ? {}
          : { parent_id: state.threadParents.get(channel) ?? state.categoryParents.get(channel) }),
      };
    } else if (/^\/channels\/\d+\/messages$/.test(path)) {
      const channel = path.split("/")[2] ?? "";
      if (state.denied.has(channel)) return { status: 403, headers: {}, body: "{}" };
      const before = url.searchParams.get("before");
      if (before && state.failBefore) {
        return { status: 503, headers: {}, body: '{"diagnostic":"private second page body"}' };
      }
      const limit = Number(url.searchParams.get("limit"));
      const all = state.messages
        .filter((message) => state.mixChannels || message.channel_id === channel)
        .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
      if (before && state.stuckBefore) body = all.slice(0, limit);
      else {
        const eligible = all.filter((message) => before === null || BigInt(message.id) < BigInt(before));
        const duplicate = before && state.overlap ? all.find((message) => message.id === before) : undefined;
        body = duplicate ? [duplicate, ...eligible.slice(0, limit - 1)] : eligible.slice(0, limit);
      }
      if (limit === 100) body = [...(body as TestDiscordMessage[]), ...state.unrelated];
    } else throw new Error(`unexpected test REST path ${path}`);
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  };
  return { state, requests, discord: new Discord(http, fakeClock(0), "unit-private-token") };
};
