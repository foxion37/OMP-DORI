import { newer, type Request, unavailable } from "./discord-inbound-api.ts";
import type { DiscordInboundStore } from "./discord-inbound-state.ts";
import { activeThreads, channelInfo } from "./discord-inbound-thread-api.ts";

export type ThreadWatch = {
  request: Request;
  explicit: readonly string[];
  watched: Map<string, DiscordInboundStore>;
  /** Configured plain channels and their original start positions, never their category parents. */
  parents: Map<string, string>;
  attach: (channelId: string, seed?: string) => Promise<string | undefined>;
};

/** Active polling membership is separate from the bounded cache of historical lookup results. */
export const discordThreads = ({ request, explicit, watched, parents, attach }: ThreadWatch) => {
  const members = new Map<string, string>();
  const history = new Map<string, string | null>();
  const discovered = new Set<string>();
  const skipped = new Set<string>();
  const guildOf = new Map<string, string | null>();
  let previousActive = new Set<string>();
  const remember = (id: string, parent: string | null) => {
    history.delete(id);
    history.set(id, parent);
    if (history.size > 256) history.delete(history.keys().next().value!);
  };
  const cached = (id: string): string | null | undefined => {
    const member = members.get(id);
    if (member !== undefined) return parents.has(member) ? member : null;
    const parent = history.get(id);
    if (parent !== undefined) remember(id, parent); // LRU: reads refresh retention.
    return parent;
  };
  const guildFor = async (id: string): Promise<string | undefined> => {
    const cached = guildOf.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const guild = (await channelInfo(request, id, false))?.guild ?? null;
    guildOf.set(id, guild);
    return guild ?? undefined;
  };
  const seedFor = (thread: string, parent: string): string => {
    const floor = parents.get(parent);
    return floor === undefined || newer(thread, floor) ? thread : floor;
  };
  const follow = async (initial: boolean): Promise<void> => {
    if (parents.size === 0) return;
    const guilds = new Set<string>();
    for (const parent of parents.keys()) {
      if (!watched.has(parent)) continue;
      const guild = await guildFor(parent);
      if (guild !== undefined) guilds.add(guild);
    }
    const active = new Map<string, string>();
    for (const guild of guilds) {
      for (const thread of (await activeThreads(request, guild)) ?? []) {
        if (parents.has(thread.parent)) active.set(thread.id, thread.parent);
      }
    }
    // Denied IDs never entered discovered: the previous listing, not successful attachment, owns their reset.
    for (const id of previousActive) {
      if (!active.has(id)) {
        skipped.delete(id);
        history.delete(id);
        if (!explicit.includes(id)) members.delete(id);
      }
    }
    previousActive = new Set(active.keys());
    for (const id of discovered) {
      if (active.has(id)) continue;
      discovered.delete(id);
      history.delete(id);
      if (!explicit.includes(id)) {
        members.delete(id);
        watched.delete(id); // Stop polling archived threads without deleting their cursor or admitted rows.
      }
    }
    for (const [id, parent] of active) {
      if (skipped.has(id)) continue;
      members.set(id, parent);
      history.delete(id);
      if (watched.has(id)) {
        discovered.add(id);
        continue;
      }
      try {
        if ((await attach(id, initial ? undefined : seedFor(id, parent))) === undefined) {
          skipped.add(id);
          continue;
        }
        discovered.add(id);
      } catch (error) {
        if (explicit.includes(id) || !unavailable(error)) throw error;
        skipped.add(id);
      }
    }
  };
  const register = async (id: string, latest: string): Promise<void> => {
    const info = await channelInfo(request, id, false);
    guildOf.set(id, info?.guild ?? null);
    if (info?.parent !== undefined) members.set(id, info.parent);
    else parents.set(id, latest);
  };
  const parentOf = async (id: string, signal?: AbortSignal): Promise<string | undefined> => {
    signal?.throwIfAborted();
    const known = cached(id);
    if (known !== undefined) return known ?? undefined;
    if (parents.size === 0) return undefined;
    const info = await channelInfo(request, id, true, signal);
    signal?.throwIfAborted(); // A closed generation must not populate even the metadata cache.
    const parent = info?.parent !== undefined && parents.has(info.parent) ? info.parent : null;
    remember(id, parent);
    return parent ?? undefined;
  };
  const adopt = (id: string, parent: string): string => {
    discovered.add(id);
    members.set(id, parent);
    history.delete(id);
    return seedFor(id, parent);
  };
  return { follow, register, parentOf, adopt, cached, seedFor };
};
