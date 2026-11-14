/** dori send, presence, inbound, thread, react and transcribe: the messengers. */
import { existsSync } from "node:fs";

import { type Command, die, envSlackToken, every, slackAuth } from "./cli-context.ts";
import { reactDiscord, sendDiscord, threadDiscord, withLocalAudio } from "./cli-discord-ops.ts";
import { discordClock, discordInboundCommand, openDiscordSocket, untilStopped } from "./cli-discord.ts";
import { discordPresence } from "./messenger/discord-presence.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { envInt, fileTgInboundStore, telegramInboundLoop } from "./messenger/telegram-inbound.ts";
import { formatTelegramInbound } from "./messenger/telegram-line.ts";
import { inboundLagLog, lagOfLine, readLagTail, summarizeLag } from "./messenger/telegram-lag.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";
import { realClock, run } from "./run.ts";

/** Messenger errors are one line, never a stack. */
export const messengerErrors = [MessengerError, UnsafeMessageError, TranscriptionError] as const;

const NO_SLACK_TOKEN = "DORI_SLACK_TOKEN is not set (nor DORI_SLACK_TOKEN_FILE)";

const send: Command = async (cli) => {
  const { key, need, opt, values, config } = cli;
  const platform = key ?? die("send needs slack, telegram or discord");
  if (platform === "discord") return await sendDiscord(cli);
  const to = need("to");
  const text = need("text");
  const thread = opt("thread");
  const edit = opt("edit");
  const token = (name: string) => process.env[name] ?? die(`${name} is not set`);
  if (platform === "slack") {
    const slack = new Slack(
      fetchHttp,
      realClock,
      slackAuth(envSlackToken() ?? die(NO_SLACK_TOKEN)),
      undefined,
      new ThreadLedger(`${config.stateDir}/slack-threads.json`),
    );
    if (edit) await slack.edit(to, edit, text);
    else console.log(`SENT ${(await slack.post(to, text, thread)).ts}`);
  } else if (platform === "telegram") {
    // Number("telegram:-1001/42") is NaN, and the Telegram target drops a falsy threadId, so a bad --thread
    // would post to the group's General topic. A flag given empty (--thread "$UNSET") is refused too: no topic
    // means leaving the flag out.
    const id = (flag: string, what: string): number | undefined => {
      if (values[flag] === undefined) return undefined;
      const value = opt(flag) ?? "";
      return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
        ? Number(value)
        : die(`--${flag} must be a Telegram ${what} id, a whole number above 0`);
    };
    const threadId = id("thread", "topic");
    const target = { chatId: to, ...(threadId !== undefined ? { threadId } : {}) };
    const messageId = id("edit", "message");
    const tg = new Telegram(fetchHttp, realClock, token("DORI_TELEGRAM_TOKEN"));
    if (messageId !== undefined) await tg.edit(target, messageId, text);
    else console.log(`SENT ${await tg.send(target, text)}`);
  } else die(`unknown platform ${platform}`);
};

const presence: Command = async ({ key }) => {
  if (key === "slack") {
    const auth = {
      token: envSlackToken() ?? die(NO_SLACK_TOKEN),
      cookie:
        process.env["DORI_SLACK_COOKIE"] ??
        die("DORI_SLACK_COOKIE is not set (user-token presence needs the d cookie)"),
    };
    const p = slackPresence(
      new Slack(fetchHttp, realClock, auth),
      (url, headers) => {
        const options: Bun.WebSocketOptions = { headers: { ...headers } };
        const ws = new WebSocket(url, options);
        return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
      },
      auth,
    );
    console.log("PRESENCE_READY slack");
    await every(1, async () => console.log(`PRESENCE slack ${await p.hold()}`));
  } else if (key === "discord") {
    const token = process.env["DORI_DISCORD_TOKEN"] ?? die("DORI_DISCORD_TOKEN is not set");
    await untilStopped(discordPresence(openDiscordSocket, token, discordClock, (line) => console.log(line)));
  } else die("presence needs slack or discord");
};

const telegramInbound = async (stateDir: string, minutes: number): Promise<void> => {
  const tg = new Telegram(
    fetchHttp,
    realClock,
    process.env["DORI_TELEGRAM_TOKEN"] ?? die("DORI_TELEGRAM_TOKEN is not set"),
  );
  const store = fileTgInboundStore(`${stateDir}/telegram-offset`);
  const num = (name: string): number => {
    try {
      return envInt(name, process.env[name]);
    } catch (e) {
      return die(e instanceof Error ? e.message : String(e));
    }
  };
  const ownerId = num("DORI_TELEGRAM_OWNER_ID");
  // One warning per process: a token that cannot react must not flood the receiver log on every message.
  let reactWarned = false;
  const groupChatId = process.env["DORI_TELEGRAM_GROUP_ID"] === undefined ? undefined : num("DORI_TELEGRAM_GROUP_ID");
  const topicId = process.env["DORI_TELEGRAM_TOPIC_ID"] === undefined ? undefined : num("DORI_TELEGRAM_TOPIC_ID");
  console.log(`INBOUND_READY telegram owner=${ownerId} group=${groupChatId ?? "-"} topic=${topicId ?? "-"}`);
  // The INBOUND line stays exactly as monitors parse it; receive lag goes to its own jsonl.
  const recordLag = inboundLagLog(`${stateDir}/telegram-lag.jsonl`, (m) => console.log(`WARN ${m}`.slice(0, 300)));
  await telegramInboundLoop(
    tg,
    store,
    {
      ownerId,
      ...(groupChatId !== undefined ? { groupChatId } : {}),
      ...(topicId !== undefined ? { topicId } : {}),
    },
    minutes,
    (i) => {
      console.log(formatTelegramInbound(i));
      recordLag(i, realClock.now());
      // Read receipt: the owner sees the message was picked up the moment it is received.
      // One reaction only (never a bubble — it would clear the typing indicator), and a
      // failed reaction must never cost the message, so it is warned once and dropped.
      if (i.kind === "message" && i.messageId !== undefined) {
        const target = { chatId: i.chat, ...(i.thread !== undefined && i.thread !== 1 ? { threadId: i.thread } : {}) };
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
  );
};

const inbound: Command = async ({ key, loopMinutes, config, values }) => {
  const minutes = loopMinutes();
  if (key === "telegram") return await telegramInbound(config.stateDir, minutes);
  if (key === "discord")
    return await discordInboundCommand(
      config.stateDir,
      values["gateway"] === true,
      values["loop"] === undefined ? 3 / 60 : minutes,
    );
  if (key !== "slack") die("inbound supports slack, telegram or discord");
  const auth = slackAuth(envSlackToken() ?? die(NO_SLACK_TOKEN));
  const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
  const slack = new Slack(fetchHttp, realClock, auth, undefined, ledger);
  const me = String((await slack.call("auth.test", {}))["user_id"] ?? die("auth.test returned no user_id"));
  console.log("INBOUND_READY slack");
  await every(minutes, async () => {
    for (const i of await pollSlackInbound(slack, ledger, { selfUserId: me }))
      console.log(
        `INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify((i.text ?? "").slice(0, 200))}`,
      );
  });
};

export const messengerCommands: Readonly<Record<string, Command>> = {
  send,
  presence,
  inbound,
  thread: async (cli) => (cli.key === "discord" ? await threadDiscord(cli) : die("thread supports discord")),
  react: async (cli) => (cli.key === "discord" ? await reactDiscord(cli) : die("react supports discord")),
  "inbound-lag": async ({ opt, config }) => {
    // Read back what the receiver recorded: without this the jsonl is a file nobody can query.
    const limitText = opt("limit");
    const limit = limitText === undefined ? 1000 : Number(limitText);
    if (!Number.isSafeInteger(limit) || limit <= 0) die("--limit must be a positive whole number of messages");
    const path = `${config.stateDir}/telegram-lag.jsonl`;
    if (!existsSync(path)) die(`no lag records yet at ${path}; messages record themselves as the receiver polls`);
    const lags: number[] = [];
    let skipped = 0;
    // Read enough blocks from the end for the requested nonblank records, including malformed ones.
    for (const line of readLagTail(path, limit)) {
      const lag = lagOfLine(line);
      if (lag === undefined) {
        skipped++; // a truncated last line from a kill mid-write is expected
        continue;
      }
      lags.push(lag);
    }
    const summary = summarizeLag(lags);
    if (summary === undefined) {
      die(`no lag readings in the last ${limit} records of ${path} (${skipped} unparseable)`);
      return;
    }
    console.log(
      `LAG n=${summary.n} p50=${summary.p50}ms p90=${summary.p90}ms p99=${summary.p99}ms max=${summary.max}ms` +
        (skipped === 0 ? "" : ` skipped=${skipped}`),
    );
  },
  transcribe: async ({ key, config }) => {
    const source = key ?? die("transcribe needs an audio file path");
    console.log(await withLocalAudio(source, (file) => transcribe(run, config.hooks.transcribe, file)));
  },
};
