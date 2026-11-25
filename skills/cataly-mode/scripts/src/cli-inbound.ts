import { inboundActivity, InboundActivityError } from "../../../../src/update/source-activity.ts";
import { type Command, die, envSlackToken, every, slackAuth } from "./cli-context.ts";
import { discordInboundCommand } from "./cli-discord.ts";
import { fetchHttp, inboundPollRetryDelay } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { formatSlackInbound, pollSlackInbound } from "./messenger/slack-inbound.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { realClock } from "./run.ts";

export const inboundCommand: Command = async ({ key, loopMinutes, config, deps, values, opt }) => {
  if (key === "telegram" && process.platform === "win32") die("Telegram intake is not supported on Windows");
  const minutes = loopMinutes();
  const context = values["context"] === true;
  if (context && key !== "discord") die("--context is supported for discord only");
  const wake = values["wake-lanes"] === true;
  if (wake && key !== "discord") die("--wake-lanes is supported for discord only");
  const activityFile = opt("activity-file");
  if (values["activity-file"] !== undefined && !activityFile) die("--activity-file must be a nonempty path");
  if (key === "telegram")
    return await (await import("./cli-telegram.ts")).telegramInbound(config, minutes, activityFile);
  if (key === "discord")
    return await discordInboundCommand(deps, {
      gateway: values["gateway"] === true,
      pollMinutes: values["loop"] === undefined ? 3 / 60 : minutes,
      context,
      wake,
      ...(activityFile ? { activityFile } : {}),
    });
  if (key !== "slack") die("inbound supports slack, telegram or discord");
  const auth = slackAuth(envSlackToken() ?? die("CATALY_SLACK_TOKEN is not set (nor CATALY_SLACK_TOKEN_FILE)"));
  const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
  const slack = new Slack(fetchHttp, realClock, auth, undefined, ledger);
  const scope = await slack.identity();
  ledger.assertReadable();
  const qualifiedRoutes = values["qualified-routes"] === true;
  const activity = inboundActivity(activityFile, "slack");
  try {
    console.log(`INBOUND_READY slack${qualifiedRoutes ? ` workspace=${scope.teamId} account=${scope.userId}` : ""}`);
    await every(
      minutes,
      async () => {
        const complete = await pollSlackInbound(slack, ledger, {}, (message) => {
          activity?.received();
          console.log(formatSlackInbound(message, qualifiedRoutes));
        });
        if (complete) activity?.healthy();
        else activity?.unavailable();
      },
      (error, interval) => {
        if (error instanceof InboundActivityError) return false;
        activity?.unavailable();
        return inboundPollRetryDelay(error, interval);
      },
    );
  } finally {
    activity?.close();
  }
};
