#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { runConsumerUpdate } from "../../../../src/release/cli.ts";
import { releaseVersion } from "../../../../src/release/version.ts";
import { runUpdate } from "../../../../src/update/cli.ts";

import { type Command, die, makeCli } from "./cli-context.ts";
import { runHarness } from "./cli-harness.ts";
import { journalCommands, journalErrors } from "./cli-journal.ts";
import { laneCommands } from "./cli-lanes.ts";
import { messengerCommands, messengerErrors } from "./cli-messenger.ts";
import { opsCommands } from "./cli-ops.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { LaunchError } from "./launch.ts";
import { Registry } from "./registry.ts";
import { realClock, run } from "./run.ts";

const USAGE = `dori <command> [options]

  harness <command> [args...]          dispatch every upstream harness command (up, inbox, duty, review, merge, loop, backlog, migrate...)
  update <command> [options]           verified releases: check, install, status, rollback [--version TAG] [--from DIST]
  upstream <command> --config FILE     maintainer staging: check, stage, watch, status, snapshot, restore, recover, restart
  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR]
         [--group NAME] [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--activity-path FILE ...] [--dry-run]
                                       --group: split below an open lane of that group, else open a workspace for it
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF] [--group NAME]
  context [--loop MIN] [--relay]        CONTEXT_HIGH / CONTEXT_UNKNOWN per lane; --relay hands full lanes to a successor
  relay  <key>                          handoff file, successor session below the lane, old session closed after STARTUP_OK
  sync   [--write]                     registry vs live panes; read-only unless --write
  boot                                 read-only check after a restart: Slack auth, vanished panes, journals, open worklog items, stale watches
  report <key> --kind milestone|blocker|question|halted|done --text TEXT
                                       append a durable progress report and print its [REPORT] line
  checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT]...
                                       record a completed step once; a conflicting rewrite is refused
  checkpoints <key>                    read completed steps before resuming remote work
  verify-pr <owner/repo> <num> [--loop N] [--cwd DIR]
                                       check every commit's author/committer email and PR-level tests; print the UI test loop (not run)
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for your own session (HC_TERMINAL_ID or HERDR_PANE_ID)
  object-done <key> --reason TEXT [--reason TEXT ...]
  lesson add <key> --rule TEXT --evidence PATH [--cwd DIR]
  lesson add --global --rule TEXT --evidence REF
                                       the lead's lesson for every lane, whatever its repo
  lesson list [--cwd DIR]             show current lessons (global ones included), newest first
  lesson mark <id> --outcome pending|helped|no-effect|harmful|encoded
  worklog add <title> --source REF     record an owner request when it arrives
  worklog next|note <id> <text>        set the item's next step, or add a note (a decision, an owner)
  worklog close <id> --result TEXT     close the item with what came of it
  worklog list [--open]                items as JSON; <stateDir>/worklog.md holds the same for reading
  close  <key> [--note TEXT] [--lesson TEXT] [--evidence PATH]
                                       close now (Done signals must read back live); an optional lesson never blocks it
  pause  <key> [--note TEXT]           the owner said wait: goal paused (read back), running turn stopped, no nudges; exit 3 if unconfirmed
  resume <key> [--note TEXT]           undo pause: goal resumed (read back), lane back to its earlier status
  watch                                long-running: emits LANE_* lines every 30 s
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]
                                       Discord accepts channel names with DORI_DISCORD_GUILD_ID; --thread needs no --to and also targets edits
  thread discord create --to CHANNEL --title T [--text T] [--tag NAME]...
  thread discord set <thread> [--title T] [--tag NAME]... [--archive|--unarchive]
                                       open a forum post or text-channel thread; rename, replace tags, archive or reopen
  react discord --to CHANNEL [--thread ID] --message ID [--emoji E] [--remove]
                                       add or remove the bot's own reaction (eyes by default); --thread needs no --to
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file|url>           run hooks.transcribe and print the text; HTTP(S) downloads are private and temporary
  inbound slack|telegram|discord [--loop MIN] [--gateway]
                                       print INBOUND lines: Slack unread thread replies / Telegram owner DMs, edits and media + configured topic
                                       the Dori posted in (any helper), DMs and channels with unread mentions
                                       Discord requires DORI_DISCORD_TOKEN, DORI_DISCORD_OWNER_ID and configured channel IDs
                                       (more channels or threads: DORI_DISCORD_CHANNEL_IDS=a,b; every readable one: DORI_DISCORD_SCOPE=all)
                                       Discord polls every 3 seconds by default; --loop MIN overrides the interval;
                                       --gateway delivers owner messages live with REST backfill and ignores --loop, including 0
  inbound-lag [--limit N]              receive-lag percentiles from state/telegram-lag.jsonl (the meter behind the INBOUND lines)`;

const [command = "", ...rest] = process.argv.slice(2);
if (command === "harness") process.exit(await runHarness(rest));
if (command === "--version") {
  console.log(releaseVersion);
  process.exit(0);
}
if (command === "update") process.exit(await runConsumerUpdate(rest));
if (command === "upstream") process.exit(await runUpdate(rest));

const config = await loadConfig().catch((e: unknown) =>
  e instanceof ConfigError ? die(e.message) : Promise.reject(e),
);
const deps: FlowDeps = { run, clock: realClock, registry: new Registry(config.stateDir), config };

const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" },
    brief: { type: "string" },
    done: { type: "string" },
    thread: { type: "string" },
    model: { type: "string" },
    cwd: { type: "string" },
    pane: { type: "string" },
    evidence: { type: "string" },
    reason: { type: "string", multiple: true },
    note: { type: "string" },
    write: { type: "boolean" },
    loop: { type: "string" },
    group: { type: "string" },
    relay: { type: "boolean" },
    gateway: { type: "boolean" },
    to: { type: "string" },
    text: { type: "string" },
    edit: { type: "string" },
    tag: { type: "string", multiple: true },
    archive: { type: "boolean" },
    unarchive: { type: "boolean" },
    message: { type: "string" },
    emoji: { type: "string" },
    remove: { type: "boolean" },
    kind: { type: "string" },
    step: { type: "string" },
    result: { type: "string" },
    "remote-effect": { type: "string", multiple: true },
    "wall-minutes": { type: "string" },
    "token-limit": { type: "string" },
    "cost-limit": { type: "string" },
    "activity-path": { type: "string", multiple: true },
    rule: { type: "string" },
    outcome: { type: "string" },
    lesson: { type: "string" },
    "dry-run": { type: "boolean" },
    global: { type: "boolean" },
    source: { type: "string" },
    open: { type: "boolean" },
    limit: { type: "string" },
  },
});

const commands: Readonly<Record<string, Command>> = {
  ...journalCommands,
  ...laneCommands,
  ...opsCommands,
  ...messengerCommands,
};
const handler = Object.hasOwn(commands, command) ? commands[command] : undefined;

try {
  if (handler) await handler(makeCli(command, rest, flags, config, deps));
  else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof LaunchError || [...messengerErrors, ...journalErrors].some((type) => e instanceof type))
    die((e as Error).message);
  throw e;
}
