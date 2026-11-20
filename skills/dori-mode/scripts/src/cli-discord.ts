/** The Discord Gateway plumbing shared by `dori presence discord` and `dori inbound discord --gateway`. */
import { join } from "node:path";
import { takeLock } from "./checkpoint-lock.ts";
import { die } from "./cli-context.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { discordLaneMonitor } from "./discord-lane-monitor.ts";
import { isDiscordWakePending } from "./discord-lane-wake-pending.ts";
import type { FlowDeps } from "./done-flow.ts";
import { Discord } from "./messenger/discord.ts";
import { DiscordChannels, inboundContext } from "./messenger/discord-channels.ts";
import type { GatewayClock, GatewaySocket } from "./messenger/discord-gateway.ts";
import { routeDiscordAskReply, routeUnreferencedDiscordAskText } from "./messenger/discord-ask-mailbox.ts";
import { type DiscordAskReceiverPublication, openDiscordAskReceiver } from "./messenger/discord-ask-receiver.ts";
import {
  discordInbound,
  formatDiscordInbound,
  formatInboundContext,
  markDiscordInboundSeen,
} from "./messenger/discord-inbound.ts";
import type { Emit } from "./messenger/discord-inbound-api.ts";
import { discordInboundLive } from "./messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "./messenger/discord-inbound-queue.ts";
import { discordInboundEnv } from "./messenger/discord-inbound-state.ts";
import { discordLaneRoute, openDiscordLaneInbox } from "./messenger/discord-lane-inbox.ts";
import { DeliveryUncertainError, fetchHttp, RateLimitError } from "./messenger/http.ts";
import { recordOwes } from "./owes.ts";
import { realClock } from "./run.ts";

export const openDiscordSocket = (url: string): GatewaySocket => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
    onMessage: (cb) => ws.addEventListener("message", (event) => cb(String(event.data))),
    onClose: (cb) => ws.addEventListener("close", (event) => cb(event.code)),
    onError: (cb) => ws.addEventListener("error", () => cb()),
  };
};

export const discordClock: GatewayClock = {
  now: realClock.now,
  random: Math.random,
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Waits for a Gateway connection to end, closing it on SIGINT or SIGTERM. */
export const untilStopped = async (gateway: { done: Promise<void>; close(): void }): Promise<void> => {
  const stop = () => gateway.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await gateway.done;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    gateway.close();
  }
};

const idList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

/**
 * Configured parents follow active threads unless DORI_DISCORD_THREADS=off; scope all keeps its own discovery.
 * `context` adds the channel, thread, topic and recorded purposes to each single stdout group.
 */
export const discordInboundCommand = async (
  deps: FlowDeps,
  options: {
    readonly gateway: boolean;
    readonly pollMinutes: number;
    readonly context: boolean;
    readonly wake: boolean;
  },
) => {
  const { gateway, pollMinutes, context, wake } = options;
  const { stateDir } = deps.config;
  if (wake && (gateway || pollMinutes <= 0)) die("--wake-lanes requires continuous Discord REST intake");
  const env = process.env;
  const ownerId = discordInboundEnv("DORI_DISCORD_OWNER_ID", env["DORI_DISCORD_OWNER_ID"]);
  const scope = env["DORI_DISCORD_SCOPE"]?.trim();
  if (scope !== undefined && scope !== "" && scope !== "all") die("DORI_DISCORD_SCOPE must be all or unset");
  const all = scope === "all";
  const setting = env["DORI_DISCORD_THREADS"]?.trim().toLowerCase();
  if (setting !== undefined && setting !== "" && setting !== "off" && setting !== "on")
    die("DORI_DISCORD_THREADS must be on, off or unset");
  const threads = setting !== "off";
  const channelIds = ["DORI_DISCORD_CHANNEL_ID", "DORI_DISCORD_CHANNEL_IDS"].flatMap((name) =>
    idList(env[name]).map((id) => discordInboundEnv(name, id)),
  );
  if (!all && channelIds.length === 0) discordInboundEnv("DORI_DISCORD_CHANNEL_ID", env["DORI_DISCORD_CHANNEL_ID"]);
  const token = env["DORI_DISCORD_TOKEN"] || die("DORI_DISCORD_TOKEN is not set");
  const queue = discordInboundQueue(stateDir);
  const delivery = { registry: deps.registry, clock: realClock };
  let receiver: DiscordAskReceiverPublication | undefined;
  let laneInbox: ReturnType<typeof openDiscordLaneInbox> | undefined;
  let releaseWake: (() => void) | undefined;
  try {
    if (wake) {
      const lock = takeLock(join(stateDir, "discord-lane-monitor.lock"), realClock.now(), (text) => new Error(text), {
        keepLiveOwner: true,
      });
      if (typeof lock !== "function")
        return die("Another Discord lane wake monitor is running for this state directory");
      releaseWake = lock;
    }
    if (!gateway && queue.first())
      die("Discord inbound has pending Gateway work; restart with --gateway before REST mode");
    const discord = new Discord(fetchHttp, realClock, token);
    const intake = await discordInbound(discord, queue.storeFor, {
      ownerId,
      channelIds: [...new Set(channelIds)],
      all,
      threads,
    });
    const identity = { bot: intake.botId, owner: ownerId };
    const serviceLanes = wake ? discordLaneMonitor(deps, discord, identity) : undefined;
    if (wake) laneInbox = openDiscordLaneInbox(stateDir);
    if (gateway || pollMinutes > 0)
      receiver = openDiscordAskReceiver(
        stateDir,
        token,
        ownerId,
        channelIds,
        intake.channels,
        gateway ? Infinity : pollMinutes * 60_000 + 15_000,
      );
    const watching = all ? "all" : intake.channels().join(",");
    const where = context ? inboundContext(discord, new DiscordChannels(stateDir), realClock.now) : undefined;
    // Context and the owner line remain one stdout group, after the owe is published.
    const emit: Emit = async (message, signal) => {
      signal?.throwIfAborted();
      if (
        routeDiscordAskReply(stateDir, message, ownerId) ||
        (message.unreferencedText && routeUnreferencedDiscordAskText(stateDir, message, ownerId))
      ) {
        await markDiscordInboundSeen(discord, message);
        return;
      }
      const route = await discordLaneRoute(stateDir, message.channel);
      if (route) {
        const held = await withDeliveryLock(delivery, route.key, async () => {
          signal?.throwIfAborted();
          const current = await discordLaneRoute(stateDir, message.channel);
          if (current && current.key !== route.key) throw new Error("Discord lane route changed; cursor not advanced");
          if (current?.kind === "closing")
            throw new Error("Discord lane native close is in progress; cursor not advanced");
          let session =
            route.kind === "live" && current?.kind === "live" && current.session === route.session
              ? current.session
              : undefined;
          // A pane between binding and native startup still owns this thread. Do not fall through to the lead.
          if (!session && wake && current?.kind === "inactive") {
            const lane = await deps.registry.read(current.key);
            if (lane?.thread === `discord:${message.channel}` && isDiscordWakePending(lane.lifecycleEpoch))
              session = lane.session;
          }
          if (!session) return false;
          signal?.throwIfAborted();
          laneInbox ??= openDiscordLaneInbox(stateDir);
          if (wake) laneInbox.add(session, message, { reply: identity });
          else laneInbox.add(session, message);
          return true;
        });
        if (!held.ok) throw new Error("Discord lane delivery is locked; cursor not advanced");
        if (held.value) {
          await markDiscordInboundSeen(discord, message);
          return;
        }
      }
      const text = where
        ? `${formatDiscordInbound(message)}\n${formatInboundContext(message, await where(message.channel))}`
        : formatDiscordInbound(message);
      await recordOwes(stateDir, text, Date.now(), signal);
      signal?.throwIfAborted();
      console.log(text);
    };
    console.log(
      `INBOUND_READY discord owner=${ownerId} channel=${watching} bot=${intake.botId}${gateway ? " mode=gateway" : ""}`,
    );
    if (!gateway) {
      const interval = pollMinutes * 60_000;
      for (;;) {
        let wait = interval;
        try {
          await intake.poll(emit);
          receiver?.refresh();
          if (serviceLanes && laneInbox) await serviceLanes(laneInbox, intake.channels());
        } catch (error) {
          receiver?.suspend();
          if (error instanceof DeliveryUncertainError) throw error;
          if (error instanceof RateLimitError) {
            if (error.retryAfterMs > error.waitLimitMs) throw error;
            wait = Math.max(interval, error.retryAfterMs);
          }
          console.log(`WARN ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
        }
        if (pollMinutes <= 0) return;
        await realClock.sleep(wait);
      }
    }
    // Gateway receipts mean successful backfill on the observed connection, not a separate connectivity probe.
    let connected = false;
    let generation = 0;
    const live = {
      ...intake,
      async sync(...args: Parameters<typeof intake.sync>) {
        const current = generation;
        try {
          await intake.sync(...args);
          if (connected && current === generation) receiver?.refresh();
        } catch (error) {
          receiver?.suspend();
          throw error;
        }
      },
    };
    await untilStopped(
      discordInboundLive(live, openDiscordSocket, token, discordClock, emit, (line) => console.log(line), queue, {
        ready() {
          connected = true;
          generation++;
        },
        disconnect() {
          connected = false;
          generation++;
          receiver?.suspend();
        },
      }),
    );
  } finally {
    releaseWake?.();
    receiver?.close();
    laneInbox?.close();
    queue.close();
  }
};
