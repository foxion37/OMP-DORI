#!/usr/bin/env bun
import { parseSkillFlags } from "./cli-flags.ts";
import { bindCliEnvironment } from "../../../../src/cli-environment.ts";
import { releaseVersion } from "../../../../src/release/version.ts";
import type { Command } from "./cli-context.ts";
import type { FlowDeps } from "./done-flow.ts";
const [command = "", ...rest] = process.argv.slice(2);
bindCliEnvironment();
const renderTablesUsage = "--render-tables requires cataly send discord (with or without --edit)";
if (
  rest.includes("--render-tables") &&
  (command === "--version" ||
    (command === "harness" &&
      (await import("../../../../src/cli-args.ts")).parse([...rest, "--"]).flags.has("render-tables")))
) {
  console.error(renderTablesUsage);
  process.exit(1);
}
const qualifiedRoutesUsage = "--qualified-routes is supported for inbound slack only";
const slackInboundOption = /^qualified-routes(?:=|$)/;
// Command-selected imports keep unrelated graphs out of short-lived CLI processes.
if (command === "harness") {
  if (rest.some((arg) => arg.startsWith("--") && slackInboundOption.test(arg.slice(2)))) {
    // Use the harness parser before it initializes state, preserving flag-like values and `--` forwarding.
    const { parse } = await import("../../../../src/cli-args.ts");
    const { flags } = parse([...rest, ""]); // Let the parser classify a trailing unknown option.
    if ([...flags.keys()].some((name) => slackInboundOption.test(name))) {
      console.error(qualifiedRoutesUsage);
      process.exit(1);
    }
  }
  process.exit(await (await import("./cli-harness.ts")).runHarness(rest));
}
if (command === "--version") {
  const end = rest.indexOf("--");
  const rejected = rest
    .slice(0, end === -1 ? rest.length : end)
    .find((arg) => arg.startsWith("--") && slackInboundOption.test(arg.slice(2)));
  if (rejected) {
    console.error(qualifiedRoutesUsage);
    process.exit(1);
  }
  console.log(releaseVersion);
  process.exit(0);
}
if (command === "update" && rest[0] === "source")
  process.exit(await (await import("../../../../src/update/source-update-cli.ts")).runSourceUpdate(rest.slice(1)));
if (command === "update") process.exit(await (await import("../../../../src/release/cli.ts")).runConsumerUpdate(rest));
if (command === "upstream") process.exit(await (await import("../../../../src/update/cli.ts")).runUpdate(rest));
if (command === "idle-check")
  process.exit(await (await import("../../../../src/update/source-update-cli.ts")).runSourceUpdate([command, ...rest]));
if (command === "lead")
  process.exit(await (await import("../../../../src/update/source-update-cli.ts")).runSourceUpdate([command, ...rest]));
if (command === "remote") process.exit(await (await import("./cli-remote.ts")).runRemote(rest));
if (command === "headless") process.exit(await (await import("./cli-headless.ts")).runHeadless(rest));
if (command === "usage") process.exit(await (await import("./cli-usage-report.ts")).runUsageReport(command, rest));
if (command === "quota") process.exit(await (await import("./cli-usage-report.ts")).runUsageReport(command, rest));
const { die, makeCli } = await import("./cli-context.ts");
const { invokeCommand, validateScheduleOptions } = await import("./cli-invoke.ts");
const { ConfigError, loadConfig } = await import("./config.ts");
const { Registry } = await import("./registry.ts");
const { realClock, run } = await import("./run.ts");
// Preserve config/native admission before argument parsing or any command execution.
const config = await loadConfig().catch((e: unknown) =>
  e instanceof ConfigError ? die(e.message) : Promise.reject(e),
);
const flags = parseSkillFlags(rest);
if (flags.values["activity-file"] !== undefined && command !== "inbound")
  die("--activity-file requires cataly inbound");
if (flags.values.runtime !== undefined && command !== "launch") die("--runtime is supported only by cataly launch");
if (flags.values["render-tables"] !== undefined && (command !== "send" || flags.positionals[0] !== "discord")) {
  if (command === "send" && ["slack", "telegram"].includes(flags.positionals[0] ?? ""))
    die("--render-tables is supported for discord only");
  die(renderTablesUsage);
}
if (flags.values["qualified-routes"] !== undefined) {
  if (command !== "inbound" || flags.positionals[0] !== "slack") die(qualifiedRoutesUsage);
  if (flags.tokens.some((token) => token.kind === "option" && token.name === "qualified-routes" && token.inlineValue))
    die("--qualified-routes is a boolean flag; pass it without a value");
}
if (command === "inbound-abandon" && flags.tokens.filter((token) => token.kind === "option").length > 1)
  die("--reason needs one explicit operator abandonment reason; no other options are accepted");
const deps: FlowDeps = { run, clock: realClock, registry: new Registry(config.stateDir), config };
let commands: Readonly<Record<string, Command>> = {};
switch (command) {
  case "report":
  case "relayed":
  case "lesson":
  case "worklog":
  case "checkpoint":
  case "checkpoints":
    commands = (await import("./cli-journal.ts")).journalCommands;
    break;
  case "lanes":
  case "launch":
  case "queue":
  case "adopt":
  case "policy":
  case "claim-done":
  case "object-done":
  case "close":
  case "park":
  case "reopen":
  case "holds":
  case "pause":
  case "resume":
  case "tell":
    commands = (await import("./cli-lanes.ts")).laneCommands;
    break;
  case "status":
  case "board":
  case "eta":
    commands = (await import("./cli-status.ts")).statusCommands;
    break;
  case "sync":
  case "boot":
  case "doctor":
  case "monitor-presets":
  case "verify-pr":
  case "watch":
  case "freshness":
  case "dead-panes":
  case "guard":
  case "heavy":
  case "can-launch":
    commands = (await import("./cli-ops.ts")).opsCommands;
    break;
  case "send":
  case "presence":
  case "inbound":
  case "thread":
  case "react":
  case "channel":
  case "inbound-lag":
  case "transcribe":
    commands = (await import("./cli-messenger.ts")).messengerCommands;
    break;
  case "artifact":
  case "artifacts":
    commands = (await import("./cli-artifacts.ts")).artifactCommands;
    break;
  case "inbound-abandon":
    commands = { "inbound-abandon": (await import("./cli-discord-recovery.ts")).abandonDiscordInbound };
    break;
  case "decision":
    commands = (await import("./cli-decisions.ts")).decisionCommands;
    break;
  case "pr":
    commands = (await import("./cli-pr.ts")).prCommands;
    break;
  case "schedule":
  case "scheduler":
    validateScheduleOptions(command, flags.tokens);
    commands = (await import("./cli-schedule.ts")).scheduleCommands;
    break;
  case "recall":
    commands = { recall: (await import("./cli-recall.ts")).recallCommand };
    break;
  case "voice":
    // Keep the opt-in voice graph out of unrelated command startup paths.
    commands = { voice: (await import("./cli-voice.ts")).voiceCommand };
}
await invokeCommand(makeCli(command, rest, flags, config, deps), commands);
