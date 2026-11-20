import { createHash } from "node:crypto";
import { withDeliveryLock } from "./delivery-lock.ts";
import { wakeDiscordLane } from "./discord-lane-wake.ts";
import type { FlowDeps } from "./done-flow.ts";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";
import { type openDiscordLaneInbox, uniqueDiscordLane } from "./messenger/discord-lane-inbox.ts";
import type { Discord } from "./messenger/discord.ts";
import { MessengerError } from "./messenger/http.ts";

export function discordLaneMonitor(
  deps: FlowDeps,
  discord: Discord,
  identity: { readonly bot: string; readonly owner: string },
) {
  const dir = deps.config.stateDir;
  const unresolved = new Set<string>();
  const warned = new Set<string>();
  return async (inbox: ReturnType<typeof openDiscordLaneInbox>, watched: readonly string[]): Promise<void> => {
    const scope = new Set(watched);
    for (const pending of inbox.pendingSessions(identity)) {
      if (!scope.has(pending.channel)) continue;
      const thread = `discord:${pending.channel}`;
      const lane = await uniqueDiscordLane(dir, (item) => item.thread === thread);
      if (lane?.session !== pending.session || lane.nativeCloseIntent) continue;
      if (pending.hasInput) {
        try {
          const wake = await wakeDiscordLane(deps, lane);
          if (wake.kind === "unconfirmed" && !unresolved.has(lane.key)) {
            console.warn(`DISCORD_LANE_WAKE_UNCONFIRMED key=${lane.key}`);
            unresolved.add(lane.key);
          } else if (wake.kind === "started") unresolved.delete(lane.key);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          if (!unresolved.has(lane.key)) console.warn(`DISCORD_LANE_WAKE_HELD key=${lane.key}`);
          unresolved.add(lane.key);
        }
      }
      try {
        const sent = await withDeliveryLock(
          deps,
          lane.key,
          async () => {
            const current = await uniqueDiscordLane(dir, (item) => item.thread === thread);
            if (current?.key !== lane.key || current.session !== pending.session || current.nativeCloseIntent) return;
            const part = inbox.nextReply(pending.session, pending.channel, identity);
            if (!part) return;
            const nonce = createHash("sha256")
              .update(`dori-lane:${identity.bot}:${pending.channel}:${part.id}:${part.part}`)
              .digest("hex")
              .slice(0, 24);
            const signal = AbortSignal.timeout(8_000);
            const messages = `/channels/${pending.channel}/messages`;
            try {
              const reply = await discord.call<{ id?: string; channel_id?: string }>(
                "POST",
                messages,
                {
                  content: part.text,
                  allowed_mentions: { parse: [], replied_user: false },
                  nonce,
                  enforce_nonce: true,
                  message_reference: { message_id: part.id, fail_if_not_exists: true },
                },
                signal,
              );
              if (!isDiscordSnowflake(reply.id) || reply.channel_id !== pending.channel)
                throw new MessengerError("Discord did not confirm the lane reply destination", 502);
              inbox.acknowledgeReply(pending.session, pending.channel, part);
            } catch (error) {
              if (!(await discordMessageMissing(discord, `${messages}/${part.id}`, error, signal))) throw error;
              inbox.discardReply(pending.session, pending.channel, part.id);
              console.warn(`DISCORD_LANE_REPLY_SOURCE_DELETED key=${lane.key}`);
            }
          },
          0,
        );
        if (sent.ok) warned.delete(lane.key);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (warned.has(lane.key)) continue;
        warned.add(lane.key);
        const detail = error instanceof MessengerError ? ` status=${error.status}` : "";
        console.warn(`DISCORD_LANE_WORK_HELD key=${lane.key}${detail}`);
      }
    }
  };
}

async function discordMessageMissing(discord: Discord, path: string, postError: unknown, signal: AbortSignal) {
  if (!(postError instanceof MessengerError) || (postError.status !== 400 && postError.status !== 404)) return false;
  if (postError.status === 404 && postError.code === "10008") return true;
  try {
    await discord.call("GET", path, undefined, signal);
    return false;
  } catch (error) {
    return error instanceof MessengerError && error.status === 404 && error.code === "10008";
  }
}
