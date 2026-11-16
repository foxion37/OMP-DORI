# Hourly loop

`dori harness loop` is the retained always-on harness process that wakes once an hour, checks state against reality, and starts the next work needing no decision. `dori harness up` starts it below the duty loop on herdr, or in its own labelled hc terminal. The duty loop works in minutes (nudges, inbox flushes); the hourly loop decides what runs next. These are source contracts for the OMP candidate, awaiting MAIN's checks and isolated runtime QA. The installer and container startup do not activate this loop.

## Where the next work comes from

A local backlog under `$DORI_HOME/backlog/`: one `<id>.json` and one `<id>.md` brief per item, where the item id becomes the lane key. The lead adds items with `dori harness backlog add` or imports labelled issues with `dori harness backlog import owner/repo --label dori`. Only the local backlog is scheduled; GitHub feeds it and supplies PR/issue state for retirement. The primary `dori` remains the skill CLI; `bun src/cli.ts loop` is the direct root entrypoint.

An item needing a person carries a `decision` question and stays unstarted while it is set. `dori harness backlog decide <id> --text ANSWER` clears it and appends the answer to the brief for the future lane. `dori harness backlog drop <id>` retires the item. Leads/duty use OMP role `dori`, implementation lanes use `lane`, and configured agent/model overrides remain intact.

## One run, in order

0. Gate. A stop file means do nothing at all. A live lock held by another process means skip; a lock whose process is dead, or whose contents are corrupt, is taken over. A run less than an interval (default one hour) after the last one means skip, unless `--force`. A skipped run writes no record.
1. Sync. A running item whose lane is done becomes done. One whose lane was lost, or whose lane record is missing, goes back to open with one more attempt, and after 2 such attempts it gets a decision ("retry, re-brief or drop?"). One whose lane is READY with a merged PR becomes done. An open item imported from an issue that is now closed is dropped.
2. Audit. Read-only checks: a working or waiting lane with no progress for 3 hours (start, READY or a report with new file/link evidence moves the progress clock; pane activity and reports without new evidence do not), a READY lane not closed after 2 hours, a lane whose pane is gone.
3. Pull. Free slots = `--max-lanes` (default 3) minus open lanes, and at most `--max-starts` (default 2) per run. Nothing starts when the 1-minute load is above the core count (or `--max-load`) or available memory is under 10% (on macOS the kernel's available-memory level, `kern.memorystatus_level`, because free pages alone sit near zero there). Candidates are open items with no decision, ordered by priority (1 first), then age, then id.
4. Ask. Each open decision is asked once through the lead as a `[DECIDE <id>]` line, with at most one reminder after 6 hours.
5. Record and report. The run is written to `loop/runs/<time>.json` (the newest 168 are kept) and `loop/last-run.json`, then one `[LOOP ...]` message goes to the lead: lanes against the limit, backlog counts, host load and memory, and each non-empty section.

Duty uses the same progress clock: it nudges quiet lanes at 10 and 20 minutes and queues one escalation after 40 minutes without progress, including waiting lanes. That queued escalation ends nudges for the epoch; new evidence or READY starts a new epoch. Older binaries could leave an explicit marker at or before their latest progress; it belongs to an earlier epoch and does not stop supervision of the current one. A legacy record without an explicit escalation marker receives one verifiable queued alert when overdue, even if it already has three nudges: the old counter cannot prove delivery. With no lead registered, no escalation is marked.

## Safety

- The loop's only side effects are opening lanes (`dori harness start`), messages to the lead, and its own files. It never merges, pushes, closes a session or edits an open lane's record. Retrying a lost item starts a fresh lane under the same key, replacing the lost record. Its `gh` calls are reads. Lanes and messages use the upstream runtime abstraction, including OMP identity/approval holds; see [runtime.md](runtime.md).
- Only the lead talks to the human. Questions reach the human through the lead.
- Kill switch: `dori harness loop stop [--text WHY]` writes `loop/stop`. Until `dori harness loop resume`, each run does nothing. The backlog remains editable while stopped.
- One loop at a time: the lock is created whole with a hard link and taken over with a rename only one process can win, a run checks it still holds the lock before each start, and the last-run stamp keeps a second loop or a cron `--once` from running the same hour twice.
- A failing `gh`, herdr or hc call becomes a finding and the run continues, including a failed report to the lead. A failed start consumes its slot; after 2 failed starts the item becomes a decision, leaving later items eligible. An opened lane whose `[START]` did not reach the lead still counts. A stopped, locked-out or failing loop waits a full interval. `dori harness loop --once` exits 1 when a run throws, so cron sees failure.
