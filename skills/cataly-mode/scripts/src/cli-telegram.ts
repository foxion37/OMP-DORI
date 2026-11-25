import { inboundActivity } from "../../../../src/update/source-activity.ts";
import { die } from "./cli-context.ts";
import type { CatalyConfig } from "./config.ts";
import { fetchHttp, MessengerError } from "./messenger/http.ts";
import { applyTelegramProfileDefaults, messengerProfileDefaultsEnabled } from "./messenger/profile-defaults.ts";
import { Telegram } from "./messenger/telegram.ts";
import { fileTgInboundStore } from "./messenger/telegram-inbound-state.ts";
import { envInt, telegramInboundLoop } from "./messenger/telegram-inbound.ts";
import { inboundLagLog } from "./messenger/telegram-lag.ts";
import { formatTelegramInbound } from "./messenger/telegram-line.ts";
import { realClock } from "./run.ts";

export const telegramInbound = async (config: CatalyConfig, minutes: number, activityFile?: string): Promise<void> => {
  const { stateDir } = config;
  const tg = new Telegram(
    fetchHttp,
    realClock,
    process.env["CATALY_TELEGRAM_TOKEN"] || die("CATALY_TELEGRAM_TOKEN is not set"),
  );
  const num = (name: string): number => {
    try {
      return envInt(name, process.env[name]);
    } catch (e) {
      return die(e instanceof Error ? e.message : String(e));
    }
  };
  const ownerId = num("CATALY_TELEGRAM_OWNER_ID");
  // One warning per process: a token that cannot react must not flood the receiver log on every message.
  let reactWarned = false;
  const groupChatId =
    process.env["CATALY_TELEGRAM_GROUP_ID"] === undefined ? undefined : num("CATALY_TELEGRAM_GROUP_ID");
  const topicId = process.env["CATALY_TELEGRAM_TOPIC_ID"] === undefined ? undefined : num("CATALY_TELEGRAM_TOPIC_ID");
  // Authentication and transport readiness must finish before advertising or consuming inbound work.
  const identity = await tg.call<{ id?: unknown; is_bot?: unknown; first_name?: unknown }>("getMe", {}).catch(() => {
    throw new MessengerError("Telegram inbound bot identity could not be verified; check token and API access", 0);
  });
  if (
    !identity ||
    identity.is_bot !== true ||
    typeof identity.id !== "number" ||
    !Number.isSafeInteger(identity.id) ||
    identity.id <= 0
  )
    throw new MessengerError("Telegram getMe returned an invalid bot identity", 0);
  const webhook = await tg.call<{ url?: unknown }>("getWebhookInfo", {}).catch(() => {
    throw new MessengerError("Telegram inbound webhook status could not be verified; check API access", 0);
  });
  if (typeof webhook?.url !== "string")
    throw new MessengerError("Telegram getWebhookInfo returned an invalid webhook status", 0);
  if (webhook.url !== "")
    throw new MessengerError("Telegram inbound refused an active webhook; use a polling bot (webhook unchanged)", 409);
  const store = fileTgInboundStore(stateDir, identity.id);
  store.checkWritable();
  store.load();
  if (messengerProfileDefaultsEnabled() && typeof identity.first_name === "string")
    await applyTelegramProfileDefaults(tg, identity.id, identity.first_name);
  // The INBOUND line stays exactly as monitors parse it; receive lag goes to its own jsonl.
  const recall = config.recall?.enabled
    ? (await import("./messenger/recall-telegram.ts")).telegramOwnerRecall(config, identity.id, ownerId)
    : undefined;
  const recordLag = inboundLagLog(`${stateDir}/telegram-lag.jsonl`, (m) => console.log(`WARN ${m}`.slice(0, 300)));
  const activity = inboundActivity(activityFile, "telegram");
  try {
    console.log(`INBOUND_READY telegram owner=${ownerId} group=${groupChatId ?? "-"} topic=${topicId ?? "-"}`);
    await telegramInboundLoop(
      tg,
      async () => store,
      {
        ownerId,
        ...(groupChatId !== undefined ? { groupChatId } : {}),
        ...(topicId !== undefined ? { topicId } : {}),
      },
      minutes,
      (i) => {
        activity?.received();
        console.log(formatTelegramInbound(i));
        recordLag(i, realClock.now());
        // Read receipt: the owner sees the message was picked up the moment it is received.
        // One reaction only (never a bubble — it would clear the typing indicator), and a
        // failed reaction must never cost the message, so it is warned once and dropped.
        if (i.kind === "message" && i.messageId !== undefined) {
          const recalled = recall?.(i);
          if (recalled) console.log(recalled);
          const target = {
            chatId: i.chat,
            ...(i.thread !== undefined && i.thread !== 1 ? { threadId: i.thread } : {}),
          };
          void tg.react(target, i.messageId, "👀").catch((e: unknown) => {
            if (reactWarned) return;
            reactWarned = true;
            console.log(
              `WARN reaction failed (${e instanceof Error ? e.message : String(e)}); still answering`.slice(0, 300),
            );
          });
        }
      },
      (m) => console.log(`WARN ${m}`.slice(0, 300)),
      undefined,
      activity ? (available) => (available ? activity.healthy() : activity.unavailable()) : undefined,
    );
  } finally {
    activity?.close();
  }
};
