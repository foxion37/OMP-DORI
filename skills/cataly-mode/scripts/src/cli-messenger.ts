/** cataly send, presence, inbound, thread, react and transcribe: the messengers. */
import { existsSync } from "node:fs";
import { InboundActivityError } from "../../../../src/update/source-activity.ts";

import { type Command, die, envSlackToken, every, messageText, slackAuth } from "./cli-context.ts";
import { discordNativeBinary } from "../../../../src/native-binary.ts";
import { reactDiscord, sendDiscord, threadDiscord } from "./cli-discord-ops.ts";
import { channelDiscord } from "./cli-discord-purpose.ts";
import { discordClock, openDiscordSocket, untilStopped } from "./cli-discord-gateway.ts";
import { inboundCommand } from "./cli-inbound.ts";
import { ChannelPurposeError } from "./messenger/discord-channels.ts";
import { discordPresence } from "./messenger/discord-presence.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { TelegramCursorError } from "./messenger/telegram-cursor-error.ts";
import { lagOfLine, readLagTail, summarizeLag } from "./messenger/telegram-lag.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { transcribe, TranscriptionError, withLocalAudio } from "./messenger/voice.ts";
import { realClock, run } from "./run.ts";

/** Messenger errors are one line, never a stack. */
export const messengerErrors = [
  MessengerError,
  UnsafeMessageError,
  TranscriptionError,
  ChannelPurposeError,
  InboundActivityError,
  TelegramCursorError,
] as const;

const NO_SLACK_TOKEN = "CATALY_SLACK_TOKEN is not set (nor CATALY_SLACK_TOKEN_FILE)";

const send: Command = async (cli) => {
  const { key, need, opt, values, config } = cli;
  const platform = key ?? die("send needs slack, telegram or discord");
  if (platform === "discord") return await sendDiscord(cli);
  // A reply that silently became a plain post would land out of context.
  if (values["reply"] !== undefined) die("--reply is supported for discord only");
  const to = need("to");
  const text = await messageText(cli);
  const thread = opt("thread");
  const edit = opt("edit");
  const token = (name: string) => process.env[name] || die(`${name} is not set`);
  if (platform === "slack") {
    // An --edit given empty ("$UNSET") or not a message ts is refused before any request: it must never post anew.
    if (values["edit"] !== undefined && !/^\d+\.\d+$/.test(edit ?? ""))
      die("--edit must be a Slack message ts, such as 1700000000.000100");
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
    const tg = new Telegram(fetchHttp, realClock, token("CATALY_TELEGRAM_TOKEN"));
    if (messageId !== undefined) await tg.edit(target, messageId, text);
    else {
      const id = await tg.send(target, text);
      console.log(`SENT ${id}`);
      if (config.recall?.enabled)
        await (await import("./messenger/recall-telegram.ts")).telegramLeadRecall(config, tg, target, id, text);
    }
  } else die(`unknown platform ${platform}`);
};

const presence: Command = async ({ key }) => {
  if (key === "slack") {
    const auth = {
      token: envSlackToken() ?? die(NO_SLACK_TOKEN),
      cookie:
        process.env["CATALY_SLACK_COOKIE"] ??
        die("CATALY_SLACK_COOKIE is not set (user-token presence needs the d cookie)"),
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
    const binary = discordNativeBinary();
    if (binary) {
      const { runNativeDiscordChild } = await import("./cli-discord-native.ts");
      return await runNativeDiscordChild([binary, "discord-presence"]);
    }
    const token = process.env["CATALY_DISCORD_TOKEN"] || die("CATALY_DISCORD_TOKEN is not set");
    await untilStopped(discordPresence(openDiscordSocket, token, discordClock, (line) => console.log(line)));
  } else die("presence needs slack or discord");
};

export const messengerCommands: Readonly<Record<string, Command>> = {
  send,
  presence,
  inbound: inboundCommand,
  thread: async (cli) => (cli.key === "discord" ? await threadDiscord(cli) : die("thread supports discord")),
  react: async (cli) => (cli.key === "discord" ? await reactDiscord(cli) : die("react supports discord")),
  channel: async (cli) => (cli.key === "discord" ? await channelDiscord(cli) : die("channel supports discord")),
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
    if (summary === undefined)
      return die(`no lag readings in the last ${limit} records of ${path} (${skipped} unparseable)`);
    console.log(
      `LAG n=${summary.n} p50=${summary.p50}ms p90=${summary.p90}ms p99=${summary.p99}ms max=${summary.max}ms` +
        (skipped === 0 ? "" : ` skipped=${skipped}`),
    );
  },
  transcribe: async ({ key, config }) => {
    const source = key ?? die("transcribe needs an audio file path");
    const hook = config.hooks.transcribe;
    console.log(await withLocalAudio(source, config.transcribeMaxBytes, (file) => transcribe(run, hook, file)));
  },
};
