export const USAGE = `cataly <command> [options]

  harness <command> [args...]          dispatch every upstream harness command (up, inbox, duty, review, merge, loop, backlog...)
  update <command> [options]           verified releases: check, install, status, rollback, cache [--version TAG] [--from DIST]
  update source check|status|apply     own main source updates; apply requires --when idle [--config FILE]
  idle-check [--owner-quiet 30m]       source update eligibility; exit 0 if idle, else 4 [--config FILE]
  lead restart --when idle            same-session managed restart [--config FILE]
  upstream <command> --config FILE     maintainer staging: check, stage, watch, status, snapshot, restore, recover, restart
  remote --help                       opt-in management of native Cataly sessions on this machine
  headless --help                     observe a headless lane or answer its exact native dialog locally
  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR]
         [--runtime headless|tern] [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none]
         [--activity-path FILE ...] [--dry-run]
         --template NAME [--set name=value]... replaces --brief; [--after a,b --expires-hours N] queues without starting
         [--request discord:C:M|telegram:CHAT:MID|slack:CHANNEL:TS] the original input ID (metadata only); each launch,
         reopen or wake gets a new local run, never an admission or completion receipt; adopt refuses it
  queue list | start <key> | cancel <key>
                                       start only on explicit command after verified predecessors, host capacity and expiry checks
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF]
  policy allow-once <key> <denyBash[index]> [--root <headless:UUID|prefix> | --skill] --reason TEXT
                                       admit one attempt of the last blocked command after owner approval; native approvals still apply
  lanes [--thread REF] [--open]        list registered lanes, optionally for one exact thread
  status [<key>] [--json]              read-only lane, runtime, journal, decision and monitor observations
  board discord|telegram [--to ID] [--thread ID] [--lane KEY] [--loop MIN] [--message ID]
                                       opt-in single status message; reuse its ID, edit only changed content
  eta <prefix> [--json]                historical closed-lane elapsed time (at least 3 samples)
  usage [<key>] [--since 24h|7d] [--by lane|thread|day] [--json]
                                       registered lane interval and verified children; API price estimates, not bills
  quota [--refresh] [--json]            opt-in account limits for display only; no account or credit changes
  sync   [--write]                     registry vs live panes; read-only unless --write
  boot                                 read-only check after a restart: Slack auth, vanished sessions, journals, open worklog items and decisions, stale watches
  doctor [--json] [--repo owner/repo]   read-only configuration, adoption and monitor diagnostics; exit 1 on warnings
  monitor-presets [name] [--json]      recommended argv and filters; starts nothing
  report <key> --kind milestone|blocker|question|halted|done --text TEXT [--owner SUMMARY] [--json] [--evidence-file PATH]...
         [--for job:ID|approval:ID|ci:owner/repo#N[@CHECK_RUN]] (blocker only)
                                       append a durable progress report; plain --for text is an unverified label
  relayed <key> --report ID [--delivery <Discord deliveryId>] [--json]
                                       acknowledge the exact journal report already sent by the lead (--json supplies ID)
  checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT]... [--evidence-file PATH]...
                                       record a completed step once; a conflicting rewrite is refused
                                       --evidence-file fingerprints the file's bytes: only new bytes are progress
  checkpoints <key>                    read completed steps before resuming remote work
  artifact add <key> <path> [--title T] [--public] / artifact delivered <key> <id> --sha256 HASH --receipt REF
  artifacts <key> [--json]             inspect files, immutable versions and operator-reported delivery receipts
                                       checkpoint --artifact ID binds its evidence to the current registered hash
  verify-pr <owner/repo> <num> [--loop N] [--cwd DIR]
                                       check every commit's author/committer email and PR-level tests; print the UI test loop (not run)
  pr track <owner/repo#N|pull-url> [--lane K] [--thread REF] / pr untrack <ref> / pr list
  pr watch [--loop MIN] [--ignore-author LOGIN]... [--self LOGIN]
                                       follow tracked PRs after their lane: PR_FEEDBACK, PR_CI_FAIL, PR_HEAD_MOVED, PR_MERGED
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for your own session (CATALY_HEADLESS_ID or TERN_PANE)
  object-done <key> --reason TEXT [--reason TEXT ...]
  lesson add <key> --rule TEXT --evidence PATH [--cwd DIR]
  lesson add --global --rule TEXT --evidence REF
                                       the lead's lesson for every lane, whatever its repo
  lesson list [--cwd DIR]             show current lessons (global ones included), newest first
  lesson mark <id> --outcome pending|helped|no-effect|harmful|encoded
  worklog add <title> --source REF [--thread REF]
                                       record an owner request when it arrives
  worklog next|note <id> <text>        set the item's next step, or add a note (a decision, an owner)
  worklog close <id> --result TEXT     close the item with what came of it
  worklog list [--open]                items as JSON; <stateDir>/worklog.md holds the same for reading
  decision ask <question> --source REF [--lane K] [--thread REF] [--kind owner|routine] [--option TEXT]... [--recommend N] [--worklog ID] [--message REF]
                                       record a choice put to the owner (up to 9 numbered options); without --kind it is the owner's,
                                       routine (reversible, in scope, 2+ options, a thread) lets the lead choose too
  decision posted <id> --message REF   record where the question was posted; a reply to that message answers it
  decision answer <id> <answer> --source REF
                                       record the owner's answer: a bare number picks that option, other text stays free text
  decision choose <id> <N> --reason TEXT --source REF --thread REF
                                       record the lead's choice of option N of a routine decision, posted with its reason in
                                       the decision's thread (--source); never an owner answer or a permission grant
  decision withdraw <id> --reason TEXT no longer needed
  decision match <message-ref>         print the open decision posted as that message; exit 1 when there is none
  decision list [--open]               decisions as JSON, oldest first
  decision digest                      one line per open decision, to paste into a status message
  close  <key> [--note TEXT] [--lesson TEXT] [--evidence PATH]
                                       close now (Done signals must read back live); an optional lesson never blocks it
  close  <key> --abandon --reason TEXT  explicitly abandon without claiming Done; preserve worktrees
  park   <key> --note TEXT [--resume-when TEXT]  pause and close a native OMP lane; preserve its session and worktrees
  reopen <key> [--note TEXT]           reopen its exact OMP session; verify the goal resume
  holds  [--thread REF]                read-only paused/parked ledger; conditions never auto-resume
  pause  <key> [--note TEXT]           the owner said wait: goal paused (read back), running turn stopped, no nudges; exit 3 if unconfirmed
  resume <key> [--note TEXT]           undo pause: goal resumed (read back), lane back to its earlier status
  tell   <key> --text TEXT             TOLD (exit 0), TELL_UNCONFIRMED (exit 3, never resend; later messages held),
                                       TELL_FAILED or TELL_HELD (exit 2, this message not sent)
  tell   <key> --status                inspect the latest local dispatch, including its exact request ID
  tell   <key> --resolve ID --note WHY  release only that uncertain hold; never confirm, cancel, or replay its action
  watch                                long-running: emits LANE_* lines every 30 s
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  schedule add NAME --cron EXPR --tz IANA [--deliver MODE] [--cwd DIR] -- argv...
  schedule add NAME --at ISO_INSTANT [--deliver MODE] [--cwd DIR] -- argv...
                                       optional --timeout-seconds 1..86400 bounds the foreground command
  schedule add NAME --every-seconds N [--on-success edge|every] [--suppress-unchanged] -- argv...
  schedule show NAME                   inspect one owned job or adopted unit read-only
  schedule add ... --dry-run           validate and print next five trigger estimates without saving/running
  schedule list | pause NAME | resume NAME [--ack-interrupted] | remove NAME
  schedule adopt [NAME] --systemd UNIT [--system]   observe an external timer/service read-only
  scheduler [--loop MIN]               opt-in runner; --loop 0 claims one tick and waits
  send <slack|telegram|discord> --to TARGET (--text TEXT | --text-file PATH|-) [--thread ID] [--edit ID] [--reply ID]
                                       Discord accepts channel names with CATALY_DISCORD_GUILD_ID; --thread needs no --to and also targets edits
                                       Discord splits text past 2000 characters (SENT lists every id); --reply and opt-in --render-tables (bounded pipe tables) are Discord only
                                       Slack accepts slack:WORKSPACE:ACCOUNT:CHANNEL and refuses a different authenticated account
  thread discord create --to CHANNEL --title T [--text T] [--tag NAME]... [--message ID]
                                       --message opens the thread on that message of a text channel
  thread discord set <thread> [--title T] [--tag NAME]... [--archive|--unarchive]
                                       open a forum post or text-channel thread; rename, replace tags, archive or reopen
  thread discord status <thread> done|working
                                       lead-owned: change the done prefix of the current title without archiving

                                       --source "discord CHANNEL MESSAGE" --lane KEY opts into verified source/lane receipts
  react discord --to CHANNEL [--thread ID] --message ID [--emoji E] [--remove]
                                       add or remove the bot's own reaction (eyes by default); --thread needs no --to
  voice discord                       opt-in owner-only voice assistant (voice.enabled in config; paid provider usage)
  channel discord set <channel> --purpose T | clear <channel> | list
                                       --source "discord CHANNEL MESSAGE" binds the command to its verified conversation
                                       the operator's purpose note per channel or thread, shown by inbound --context
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file|url>           run hooks.transcribe and print the text; HTTP(S) downloads are private and temporary
  inbound slack|telegram|discord [--loop MIN] [--gateway] [--context] [--activity-file PATH]
                                       Slack defaults to INBOUND_READY slack and physical channel IDs;
                                       --qualified-routes opts into account-qualified readiness and destinations
                                       print INBOUND lines: Slack unread thread replies / Telegram owner DMs, edits and media + configured topic
                                       the Cataly posted in (any helper), DMs and channels with unread mentions
                                       Discord requires CATALY_DISCORD_TOKEN, CATALY_DISCORD_OWNER_ID and configured channel IDs
                                       (more channels or threads: CATALY_DISCORD_CHANNEL_IDS=a,b; threads of a watched channel are followed unless
                                       CATALY_DISCORD_THREADS=off; every readable one: CATALY_DISCORD_SCOPE=all)
                                       Discord polls every 3 seconds by default; --loop MIN overrides the interval;
                                       --gateway delivers owner messages live with REST backfill and ignores --loop, including 0
                                       --context (Discord) adds INBOUND_CONTEXT: channel, thread, topic and recorded purposes
                                       --wake-lanes (Discord, continuous REST) reopens verified lanes and sends threaded replies
  inbound-abandon discord BOT:OWNER:CHANNEL:MESSAGE --reason TEXT
                                       record an explicit decision after the original native head stops; never resend
  recall --scope PLATFORM:BOT:OWNER --space=ID [--limit N] QUERY
                                       search one explicitly scoped local conversation space; off by default
  recall --scope PLATFORM:BOT:OWNER --purge
                                       logically delete that identity’s scoped rows only
  inbound-lag [--limit N]              receive-lag percentiles from state/telegram-lag.jsonl (the meter behind the INBOUND lines)`;
