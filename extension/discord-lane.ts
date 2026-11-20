import { existsSync } from "node:fs";
import { join } from "node:path";
import { withDeliveryLock } from "../skills/dori-mode/scripts/src/delivery-lock.ts";
import { isDiscordWakePending } from "../skills/dori-mode/scripts/src/discord-lane-wake-pending.ts";
import { readPaneState } from "../skills/dori-mode/scripts/src/lane-state.ts";
import {
  routeDiscordAskReply,
  routeUnreferencedDiscordAskText,
} from "../skills/dori-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import {
  type DiscordAskReceiverPublication,
  discordAskReceivers,
  openDiscordAskReceiver,
} from "../skills/dori-mode/scripts/src/messenger/discord-ask-receiver.ts";
import { discordInbound, markDiscordInboundSeen } from "../skills/dori-mode/scripts/src/messenger/discord-inbound.ts";
import { discordInboundQueue } from "../skills/dori-mode/scripts/src/messenger/discord-inbound-queue.ts";
import {
  type DiscordLaneInbox,
  discordLaneTarget,
  openDiscordLaneInbox,
  uniqueDiscordLane,
} from "../skills/dori-mode/scripts/src/messenger/discord-lane-inbox.ts";
import { Discord } from "../skills/dori-mode/scripts/src/messenger/discord.ts";
import { fetchHttp } from "../skills/dori-mode/scripts/src/messenger/http.ts";
import { Registry, sameLaneGeneration, sessionOf, statusOf } from "../skills/dori-mode/scripts/src/registry.ts";
import { realClock } from "../skills/dori-mode/scripts/src/run.ts";
import { discordAskToken, routeFor } from "./discord-ask.ts";
import { type AskLane, laneChannel } from "./discord-ask-auto.ts";
import { DiscordLaneReplies, type NativeDelivery, nativeDiscordReceipt } from "./discord-lane-reply.ts";
import type { DoriApi, DoriContext } from "./index.ts";

const POLL_MS = 3_000;
const PREFIX = "[discord] ";
const HELD = "Discord lane input was held; it will not be retried automatically.";

type LaneAdmission = {
  readonly idle: () => boolean;
  readonly goalAllows: (optedIn: boolean, claimed?: boolean) => boolean;
  readonly consumePause: () => void;
};

type NativeAttempt = {
  readonly input: NativeDelivery;
  readonly check: (ctx: DoriContext) => Promise<boolean>;
  readonly hold: () => void;
  prepared: boolean;
};

/** Lane intake belongs to the foreground OMP session rather than its terminal or the lead's model. */
export class DiscordLane {
  private stopLoop?: () => void;
  agentStart?: (session: string) => void;
  agentEnd?: (session: string, event: unknown) => void;
  beforeAgentStart?: (event: unknown, ctx: DoriContext) => Promise<void>;
  beforeProviderRequest?: (ctx: DoriContext) => void;

  stop(): void {
    this.stopLoop?.();
    this.stopLoop = undefined;
    this.agentStart = undefined;
    this.agentEnd = undefined;
    this.beforeAgentStart = undefined;
    this.beforeProviderRequest = undefined;
  }

  start(
    pi: DoriApi,
    root: string,
    ctx: DoriContext,
    binding: AskLane | undefined,
    dedicated: boolean,
    admission: LaneAdmission,
  ): void {
    this.stop();
    if (ctx.mode !== "tui") return;
    const paneId = process.env.HC_TERMINAL_ID || process.env.HERDR_PANE_ID;
    if (!paneId) return;
    const session = ctx.sessionManager.getSessionId();
    const wakeSession = process.env.DORI_DISCORD_WAKE_SESSION;
    const wakeModel = process.env.DORI_DISCORD_WAKE_MODEL;
    const matchesModel = (model: DoriContext["model"]) =>
      wakeModel === undefined
        ? wakeSession === undefined
        : model?.provider !== undefined && `${model.provider}/${model.id}` === wakeModel;
    const lifecycle = new AbortController();
    const delivery = { registry: new Registry(root), clock: realClock };
    const { signal } = lifecycle;
    const ownsPane = () => {
      if (signal.aborted || ctx.sessionManager.getSessionId() !== session) return false;
      const state = readPaneState(root, paneId);
      return state?.role === "lane" && state.pid === process.pid && state.sessionId === session;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inbox: DiscordLaneInbox | undefined;
    let rootInbox: DiscordLaneInbox | undefined;
    let intake: { receiver: Awaited<ReturnType<typeof discordInbound>>; discord: Discord } | undefined;
    let queue: ReturnType<typeof discordInboundQueue> | undefined;
    let receiver: DiscordAskReceiverPublication | undefined;
    let isolatedRoute: string | undefined;
    let confirm: (() => boolean) | undefined;
    let native: NativeAttempt | undefined;
    let dispatching: Promise<void> | undefined;
    let modelWarned = false;
    let warned = false;
    this.stopLoop = () => {
      lifecycle.abort();
      clearTimeout(timer);
      receiver?.close();
      queue?.close();
      // A late native settlement still owns its claimed row, even if this lane has since switched away.
      const closeInboxes = () => {
        inbox?.close();
        rootInbox?.close();
      };
      if (dispatching) void dispatching.then(closeInboxes, closeInboxes);
      else {
        if (confirm) native?.hold();
        closeInboxes();
      }
    };

    const delivered = (text: string) =>
      ctx.sessionManager
        .getBranch()
        .some(
          (entry) => entry.type === "custom_message" && entry.customType === "dori-monitor" && entry.content === text,
        );

    const replies = new DiscordLaneReplies(() => (ownsPane() ? ctx.sessionManager.getBranch() : []));
    this.agentStart = (currentSession) => {
      if (currentSession === session) replies.agentStart();
    };
    this.agentEnd = (currentSession, event) => {
      if (currentSession === session) replies.agentEnd(event);
    };
    this.beforeAgentStart = async (event, liveCtx) => {
      const attempt = native;
      if (
        !attempt ||
        liveCtx.sessionManager.getSessionId() !== session ||
        typeof event !== "object" ||
        event === null ||
        !("reason" in event) ||
        event.reason !== "prompt" ||
        !("prompt" in event) ||
        event.prompt !== attempt.input.prompt
      ) {
        return;
      }
      if (!(await attempt.check(liveCtx))) {
        liveCtx.abort();
        attempt.hold();
        return;
      }
      attempt.prepared = true;
      replies.prepareNative(attempt.input);
    };
    this.beforeProviderRequest = (liveCtx) => {
      const attempt = native;
      if (!attempt || liveCtx.sessionManager.getSessionId() !== session || matchesModel(liveCtx.model)) return;
      // Request middleware receives the actual provider model, unlike the launch or UI selection.
      if (!attempt.prepared && !nativeDiscordReceipt(liveCtx.sessionManager.getBranch(), attempt.input)) return;
      liveCtx.abort();
      attempt.hold();
    };

    const drain = async (source: DiscordLaneInbox, target: { channel: string; key: string; allowReply?: boolean }) => {
      const { channel, key, allowReply } = target;
      await withDeliveryLock(
        delivery,
        key,
        async () => {
          const current = await delivery.registry.read(key);
          if (!current || current.nativeCloseIntent || isDiscordWakePending(current.lifecycleEpoch)) return;
          const status = statusOf(current);
          if (status === "closed" || status === "paused") return;
          if (!dedicated) {
            const route = await discordLaneTarget(root, channel);
            if (route?.session !== session || route.key !== key) return;
          }
          const allowLegacy = admission.goalAllows(false);
          const allowOptedIn = allowReply === true && admission.goalAllows(true);
          if (!allowLegacy && !allowOptedIn) return;
          const message = source.next(session, channel, allowLegacy ? undefined : { optedInOnly: true });
          if (!message) return;
          const text = PREFIX + message.text;
          const optedIn = message.reply === true;
          if (!optedIn && delivered(text)) {
            source.acknowledge(session, channel, message.id);
            return;
          }
          if (confirm || !admission.idle() || ctx.isIdle?.() === false || !ownsPane()) return;
          if (
            (wakeSession !== undefined && (wakeSession !== session || current.session !== session)) ||
            ((optedIn || wakeSession !== undefined) && !matchesModel(ctx.model))
          ) {
            if (!modelWarned) {
              ctx.ui.notify("Discord lane input is waiting for the attested native session and model.", "warning");
            }
            modelWarned = true;
            return;
          }
          modelWarned = false;
          if (!optedIn) {
            pi.sendMessage(
              { customType: "dori-monitor", content: text, display: true },
              { triggerTurn: true, deliverAs: "aside" },
            );
            confirm = () => {
              if (!delivered(text)) return false;
              source.acknowledge(session, channel, message.id);
              return true;
            };
            return;
          }
          if (!allowOptedIn || ctx.hasPendingMessages?.()) return;
          const input = replies.armNative(text, (parts) =>
            source.enqueueReply(session, channel, { id: message.id, parts }),
          );
          if (!input) return;
          if (!source.claimInput(session, channel, message.id)) {
            replies.discardNative(input);
            return;
          }
          admission.consumePause();
          let held = false;
          const attempt: NativeAttempt = {
            input,
            prepared: false,
            check: async (liveCtx) => {
              const lane = await delivery.registry.read(key);
              return (
                lane?.key === key &&
                sessionOf(lane)?.id === paneId &&
                (lane.session === session || (wakeSession === undefined && lane.session === undefined)) &&
                sameLaneGeneration(current, lane) &&
                !lane.nativeCloseIntent &&
                ownsPane() &&
                admission.goalAllows(true, true) &&
                matchesModel(liveCtx.model)
              );
            },
            hold: () => {
              if (held) return;
              held = true;
              replies.discardNative(input);
              source.holdInput(session, channel, message.id);
              if (ownsPane()) ctx.ui.notify(HELD, "warning");
            },
          };
          native = attempt;
          // Call under the admission lock, but never hold the lock for a whole native turn.
          dispatching = (async () => {
            try {
              // An aside starts an idle turn but never steers a concurrent run.
              await pi.sendUserMessage(text, { deliverAs: "aside" });
            } catch {
              attempt.hold();
              return;
            }
            if (held) return;
            confirm = () => {
              if (nativeDiscordReceipt(ctx.sessionManager.getBranch(), input) && ownsPane()) {
                source.acknowledge(session, channel, message.id);
                replies.acceptNative(input);
                return true;
              }
              if (!signal.aborted && (ctx.isIdle?.() === false || ctx.hasPendingMessages?.())) return false;
              attempt.hold();
              return true;
            };
            if (confirm()) confirm = undefined;
          })();
        },
        0,
      );
      if (dispatching) {
        try {
          await dispatching;
        } finally {
          dispatching = undefined;
          if (!confirm || signal.aborted) native = undefined;
        }
      }
    };

    const run = async (): Promise<void> => {
      if (!ownsPane()) return;
      try {
        if (confirm?.()) {
          confirm = undefined;
          native = undefined;
        }
        // A manually bound session can already name a separate receiver root. Reuse that exact connection,
        // but never start another Discord poller for the shared receiver or for an ASK-only opt-out.
        const explicit = dedicated ? routeFor(root, session) : undefined;
        const routeKey = explicit && explicit.receiverStateDir !== root ? JSON.stringify(explicit) : undefined;
        if (routeKey !== isolatedRoute) {
          // A changed connection may not drain the old connection's messages into this lane.
          if (confirm) return;
          inbox?.close();
          inbox = undefined;
          intake = undefined;
          queue?.close();
          queue = undefined;
          receiver?.close();
          receiver = undefined;
          isolatedRoute = routeKey;
        }
        if (explicit && explicit.receiverStateDir !== root) {
          const stateDir = explicit.receiverStateDir;
          const lane = await uniqueDiscordLane(root, (entry) => entry.sessionRef?.id === paneId, true);
          if (!lane || (lane.session !== undefined && lane.session !== session) || !ownsPane()) return;
          const token = discordAskToken(explicit);
          if (
            discordAskReceivers(root, token).some(
              (item) => item.owner === explicit.owner && item.watched.includes(explicit.channel),
            )
          )
            throw new Error("The shared Discord receiver already owns this lane channel");
          if (!intake) {
            queue ??= discordInboundQueue(stateDir);
            if (queue.first()) throw new Error("Complete pending Gateway intake before taking over this receiver");
            const discord = new Discord(
              (request) =>
                fetchHttp({
                  ...request,
                  signal: AbortSignal.any([
                    signal,
                    AbortSignal.timeout(10_000),
                    ...(request.signal ? [request.signal] : []),
                  ]),
                }),
              realClock,
              token,
            );
            const scopedIntake = await discordInbound(discord, queue.storeFor, {
              ownerId: explicit.owner,
              channelIds: [explicit.channel],
              threads: false,
            });
            intake = { receiver: scopedIntake, discord };
            if (!ownsPane()) return;
            receiver = openDiscordAskReceiver(
              stateDir,
              token,
              explicit.owner,
              [explicit.channel],
              scopedIntake.channels,
              15_000,
            );
          }
          if (!ownsPane()) return;
          const receiverInbox = inbox ?? openDiscordLaneInbox(stateDir);
          inbox = receiverInbox;
          const { receiver: scopedIntake, discord } = intake;
          await scopedIntake.poll(async (message) => {
            signal.throwIfAborted();
            if (
              routeDiscordAskReply(stateDir, message, explicit.owner) ||
              (message.unreferencedText && routeUnreferencedDiscordAskText(stateDir, message, explicit.owner))
            ) {
              await markDiscordInboundSeen(discord, message);
              return;
            }
            const held = await withDeliveryLock(delivery, lane.key, async () => {
              signal.throwIfAborted();
              const current = await delivery.registry.read(lane.key);
              if (!current || current.nativeCloseIntent || statusOf(current) === "closed" || !ownsPane())
                throw new Error("The dedicated Discord lane changed; cursor not advanced");
              receiverInbox.add(session, message);
            });
            if (!held.ok) throw new Error("Discord lane delivery is locked; cursor not advanced");
            await markDiscordInboundSeen(discord, message);
          });
          if (!ownsPane()) return;
          receiver?.refresh();
          await drain(inbox, { channel: explicit.channel, key: lane.key });
        } else if (existsSync(join(root, "discord-lanes", "inbox.sqlite"))) {
          const channel = await laneChannel(root, session, binding);
          const target = channel ? await discordLaneTarget(root, channel) : undefined;
          if (target?.session === session && channel && ownsPane()) {
            rootInbox ??= openDiscordLaneInbox(root);
            await drain(rootInbox, { channel, key: target.key, allowReply: !explicit });
          }
        }
        warned = false;
      } catch {
        receiver?.suspend();
        if (!signal.aborted && !warned)
          ctx.ui.notify("Discord lane intake is unavailable; pending messages remain queued.", "warning");
        warned = true;
      } finally {
        if (!signal.aborted) timer = setTimeout(() => void run(), POLL_MS).unref();
      }
    };
    timer = setTimeout(() => void run(), 0).unref();
  }
}
