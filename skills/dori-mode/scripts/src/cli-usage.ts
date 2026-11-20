export const USAGE = `dori <command> [options]

  harness <command> [args...]          dispatch every upstream harness command (up, inbox, duty, review, merge, loop, backlog, migrate...)
  update <command> [options]           verified releases: check, install, status, rollback, cache [--version TAG] [--from DIST]
  upstream <command> --config FILE     maintainer staging: check, stage, watch, status, snapshot, restore, recover, restart
  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR]
         [--group NAME] [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--activity-path FILE ...] [--dry-run]
         --template NAME [--set name=value]... replaces --brief; [--after a,b --expires-hours N] queues without starting
                                       --group: split below an open lane of that group, else open a workspace for it
  queue list | start <key> | cancel <key>
                                       start only on explicit command after verified predecessors, host capacity and expiry checks
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF] [--group NAME]
  context [--loop MIN] [--relay]       CONTEXT_HIGH / CONTEXT_UNKNOWN per lane; --relay hands full lanes to a successor
  relay  <key>                          handoff file, successor session below the lane, old session closed after STARTUP_OK
  lanes [--thread REF] [--open]        list registered lanes, optionally for one exact thread
  status [<key>] [--json]              read-only lane, runtime, journal, decision and monitor observations
  board discord|telegram [--to ID] [--thread ID] [--lane KEY] [--loop MIN] [--message ID]
                                       opt-in single status message; reuse its ID, edit only changed content
  eta <prefix> [--json]                historical closed-lane elapsed time (at least 3 samples)
  sync   [--write]                     registry vs live panes; read-only unless --write
  boot                                 read-only check after a restart: Slack auth, vanished panes, journals, open worklog items and decisions, stale watches
  doctor [--json] [--repo owner/repo]   read-only configuration, adoption and monitor diagnostics; exit 1 on warnings
  monitor-presets [name] [--json]      recommended argv and filters; starts nothing
  report <key> --kind milestone|blocker|question|halted|done --text TEXT [--owner SUMMARY] [--json]
                                       append a durable progress report and print its [REPORT] line
  relayed <key> --report ID            acknowledge the exact journal report already sent by the lead (--json supplies ID)
  checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT]...
                                       record a completed step once; a conflicting rewrite is refused
  checkpoints <key>                    read completed steps before resuming remote work
  verify-pr <owner/repo> <num> [--loop N] [--cwd DIR]
                                       check every commit's author/committer email and PR-level tests; print the UI test loop (not run)
  pr track <owner/repo#N|pull-url> [--lane K] [--thread REF] / pr untrack <ref> / pr list
  pr watch [--loop MIN] [--ignore-author LOGIN]... [--self LOGIN]
                                       follow tracked PRs after their lane: PR_FEEDBACK, PR_CI_FAIL, PR_HEAD_MOVED, PR_MERGED
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for your own session (HC_TERMINAL_ID or HERDR_PANE_ID)
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
  tell   <key> --text TEXT             one verified message to the lane's agent: TOLD (exit 0), TELL_UNCONFIRMED (exit 3,
                                       never resend), TELL_FAILED (exit 2, nothing sent: shell, approval, hc blocked
                                       agent, paused lane; a runtime refusal names the status read after it)
  watch                                long-running: emits LANE_* lines every 30 s
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  send <slack|telegram|discord> --to TARGET (--text TEXT | --text-file PATH|-) [--thread ID] [--edit ID] [--reply ID]
                                       Discord accepts channel names with DORI_DISCORD_GUILD_ID; --thread needs no --to and also targets edits
                                       Discord splits text past 2000 characters (SENT lists every id); --reply and opt-in --render-tables (bounded pipe tables) are Discord only
                                       Slack accepts slack:WORKSPACE:ACCOUNT:CHANNEL and refuses a different authenticated account
  thread discord create --to CHANNEL --title T [--text T] [--tag NAME]... [--message ID]
                                       --message opens the thread on that message of a text channel
  thread discord set <thread> [--title T] [--tag NAME]... [--archive|--unarchive]
                                       open a forum post or text-channel thread; rename, replace tags, archive or reopen
  thread discord status <thread> done|working
                                       lead-owned: change the done prefix of the current title without archiving
  react discord --to CHANNEL [--thread ID] --message ID [--emoji E] [--remove]
                                       add or remove the bot's own reaction (eyes by default); --thread needs no --to
  voice discord                       opt-in owner-only voice assistant (voice.enabled in config; paid provider usage)
  channel discord set <channel> --purpose T | clear <channel> | list
                                       the operator's purpose note per channel or thread, shown by inbound --context
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file|url>           run hooks.transcribe and print the text; HTTP(S) downloads are private and temporary
  inbound slack|telegram|discord [--loop MIN] [--gateway] [--context]
                                       Slack defaults to INBOUND_READY slack and physical channel IDs;
                                       --qualified-routes opts into account-qualified readiness and destinations
                                       Slack: --adopt-legacy-threads WORKSPACE:ACCOUNT explicitly binds an old unscoped ledger
                                       print INBOUND lines: Slack unread thread replies / Telegram owner DMs, edits and media + configured topic
                                       the Dori posted in (any helper), DMs and channels with unread mentions
                                       Discord requires DORI_DISCORD_TOKEN, DORI_DISCORD_OWNER_ID and configured channel IDs
                                       (more channels or threads: DORI_DISCORD_CHANNEL_IDS=a,b; threads of a watched channel are followed unless
                                       DORI_DISCORD_THREADS=off; every readable one: DORI_DISCORD_SCOPE=all)
                                       Discord polls every 3 seconds by default; --loop MIN overrides the interval;
                                       --gateway delivers owner messages live with REST backfill and ignores --loop, including 0
                                       --context (Discord) adds INBOUND_CONTEXT: channel, thread, topic and recorded purposes
                                       --wake-lanes (Discord, continuous REST) reopens verified lanes and sends threaded replies
  inbound-lag [--limit N]              receive-lag percentiles from state/telegram-lag.jsonl (the meter behind the INBOUND lines)`;
