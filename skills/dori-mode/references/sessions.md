# Sessions (lanes)

A lane is one agent session doing one job in its own herdr tab or hc terminal. You launch it, track it in the registry, answer it when it is stuck, and close it when its work is proven done.

## Launching

```sh
dori launch fix-login --title "Fix the login redirect loop" \
  --brief ~/briefs/fix-login.md --done "merged acme/app#412; closed acme/app#398" \
  --thread "telegram:<chat>/<topic>" --model anthropic/claude-opus-5-5
```

`launch` checks the key and the `Done =` line, appends a footer to the brief, opens a tab in `laneWorkspace`, starts the agent, and after 20 seconds checks the start: `STARTUP_ERROR` on a known failure (missing module, no API key, rate limit, quota), also when one shows on an idle agent during the goal wait, `STARTUP_OK` only when the runtime reports the agent idle or working (herdr reports an agent that finished its first turn as `done`, which is ready too) and it shows a goal (checked again every 10 seconds until `startupWaitSeconds`, 180 by default, after the start; an agent that has not reported a status yet is waited for too), `STARTUP_NO_GOAL` when it still shows no goal after that, `STARTUP_DONE <key>` when the session is gone and the lane already finished (closed, verified-done or reported done; exit 0, nothing to do), `STARTUP_UNCONFIRMED` otherwise. On `STARTUP_ERROR`, relaunch on another model; on `STARTUP_NO_GOAL`, tell the lane to set its goal, since a lane without one stops after its first turn; on `STARTUP_UNCONFIRMED`, look at the pane before doing anything else.

Write the brief like a careful prompt:

- open with the keywords you would type yourself (for example `ulw set goal and work`);
- the original request/source references and only the facts learned that matter to this task, not the whole lead transcript;
- the allowed repositories, worktree and branch, with the execution directory explicit when it differs from the lead's;
- the observable acceptance, checks and stop condition, from the point of view of whoever uses the result;
- resources and user changes to preserve, unfinished external effects and their receipts, and the latest resume checkpoint;
- the work thread, how to report, and a deadline only if one actually exists.

On a follow-up or resume, read the brief, registry and existing checkpoint history before acting. Keep the original source, allowed repository/branch, acceptance and report route unless the lead explicitly changes the assignment; another session's cwd or an unrelated message is not such a change. The launch footer repeats recorded locations, but those paths grant no additional authority. If a material field is missing or conflicts with live state, resolve it with the lead before the affected work rather than inventing values, permissions or deadlines. Inspect uncertain external effects by their receipts before repeating them.

**Why the `Done =` line has to be checkable:** the watcher closes lanes on its own, so it can only trust what it can read back itself. `launch` and `adopt` refuse any signal outside this list. Signals are joined with `;`, and every one has to pass.

| Signal | Passes when |
|---|---|
| `merged <owner/repo>#N` | the PR is merged and has a merge commit |
| `closed <owner/repo>#N` | the issue is closed |
| `published <pkg>@<version>` | npm has that exact version |
| `command ["argv","as","json"] [stdout~"regex"]` | the command exits 0 when the watcher runs it, and stdout matches if a regex is given |
| `file <path> [sha256=<hex>] [json:.a.b=<json value>]` | the file exists, its sha256 matches, and the JSON field equals the value |
| `url <http(s) url> [status=200] [body~"regex"]` | a GET returns that status, and the body matches if a regex is given |

The last three are for work that never lands as a PR: a local setup, a QA pass, a running service. Write the check so that it can fail. `command ["bun","test"] stdout~" 0 fail"` is a real check, while `command ["true"]` checks nothing. The watcher runs commands itself, in the lane's directory, as a plain argv with no shell. They have a 2-minute limit. It never trusts the lane's own report that something passed. Relative file paths resolve from the lane's directory, and `~` is your home. JSON values compare as JSON, so `json:.n=3` and `json:.n="3"` are different checks.

Example for a QA-only lane:

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

Work no script can check (a design review, a judgement call) stays in the lane's own plan. You judge it yourself before the claim.

## Templates and prerequisite queues

Store local Markdown templates under `templates/` beside `DORI_CONFIG` (normally `~/.dori/templates/`). `{{name}}` inserts a required literal variable; `{{>common}}` includes `common.md` from the same directory. Includes may nest, but cycles, missing variables, invalid names and symlink escapes are refused. No shell or template code is evaluated.

```sh
dori launch deploy-beta --title "Deploy the verified build" --template deploy \
  --set branch=main --set target=beta --done "file /srv/reports/deploy-beta.json json:.passed=true" --dry-run
dori launch verify-build --title "Verify the finished build" --brief ~/briefs/verify-build.md \
  --done "closed acme/app#412" --after build-app --expires-hours 24
dori queue list
dori queue start verify-build
dori queue cancel verify-build
```

`--template` replaces `--brief`; repeated `--set name=value` supplies variables. `--dry-run` prints the rendered brief and footer without writing files, registering a lane, queueing or opening a terminal. `queue start` and `queue cancel` reject `--dry-run`. An actual template launch creates a new brief at `<stateDir>/briefs/<key>.md` without overwriting existing files or following an output link. Explicit `--brief` files retain their existing behavior.

Before opening a terminal, Dori stages generated text in a private attempt directory beside the intended brief. It creates the usual brief path only after the terminal returns an identity, and never replaces an existing path. A confirmed creation rejection clears only the private attempt. If creation is uncertain, Dori keeps the attempt and holds an immediate retry; inspect the recorded path and terminal first. A queued attempt still requires explicit cancellation and a fresh reservation before any retry.

`--after a,b` snapshots the prepared brief and its effective absolute working directory in `<stateDir>/launch-queue/` and reserves its lane key without starting an agent. `--cwd` overrides the enqueue-time default. Older reservations missing `cwd` still use the default at start time; inspect them with `queue list` and cancel and requeue with `--cwd` if the original directory matters. Predecessors must already be known lanes or queue entries; cycles and self-dependencies are refused. The default expiry is 24 hours. `queue list` and `boot` preserve visibility after a restart; `watch` emits a changed `LANE_QUEUE_READY`, `LANE_QUEUE_HELD` or `LANE_QUEUE_WARN` notice but **never starts a queued lane**. Readiness is based only on stored status/receipt/expiry, not permission to run: watch never executes Done commands or host probes. Damaged queue files are reported separately by list/boot/watch without hiding valid entries; list and boot return nonzero for that damage.

The working directory must exist when enqueued. Dori follows symlinks and `..` in filesystem order and stores the resulting directory.

Starting rechecks every predecessor's closed status, successful normal-completion receipt and live Done signals, then current host capacity and expiry. A changed predecessor generation or completion receipt holds the start. Paused, parked, abandoned or merely claimed lanes are not completion. A queue snapshot does not track later brief/template edits. Expired entries require explicit cancellation and a reviewed new queue request. No worktree or running agent is removed by cancellation.

Starts are serialized with immediate launch/adopt for the same key, independently of pause/tell delivery so startup checks cannot block an operator interruption. Different queued keys sharing the state directory serialize the host-capacity check through terminal creation, not startup confirmation. Dependency graph updates are serialized across keys to prevent concurrent requeues from adding a cycle. A durable `starting` record precedes terminal creation; a crash or uncertain startup never triggers an automatic retry. Inspect the registry and terminal: cancellation can release an unregistered attempt, but a registered lane must use its ordinary lifecycle controls. A `started` receipt means the launch attempt was recorded, not that the goal finished; inspect the printed `STARTUP_*` result.

## The registry

One JSON file per lane under `<stateDir>/lanes/`, written atomically (temp file + rename), so two writers never leave a half-written file. Each lane records:

| Field | Meaning |
|---|---|
| `thread` | where its updates go, as `platform:thread` (or `none`) |
| `sessionRef` | its session: the runtime (`herdr` or `hc`) and the id; `pane` and `tab` mirror the id and the herdr tab (none on hc). A record from before runtimes existed is read as herdr |
| `session` | the agent's own session id, so a closed job can be reopened later |
| `status` | `working`, `done-claimed`, `verified-done`, `not-done`, `closed` |
| `claim`, `objection`, `history` | what was claimed, what was objected, every status change |

`dori sync` compares the registry with live panes and prints drift (a pane that is gone, a session id that changed, an empty `Done =` line). It never deletes anything. With `--write` it stores the session ids it found.

How the session id is found for a pane, in order:

1. the role-gated OMP extension's record under `<stateDir>/sessions/<encoded runtime id>.json`, trusted only when its PID belongs to the current session's live agent process;
2. an OMP session file in `sessionsDir` whose timestamp matches that process, using OMP's temporary, home-relative and legacy directory encodings.

The extension updates its record when the agent switches sessions. A stale PID, wrong terminal or approval-pending record never becomes permission to type into another process. On hc, OMP reports native OSC 7501 status so the runtime's conditional send gate remains active; unknown status stays held.

When work is assigned back to a closed lane, use `dori reopen <key> [--note TEXT]`. A reply in the original work thread is not a hand-back while main owns that work. Keep the lane closed until main hands it back. During main ownership, send new instructions to the lead conversation or main session, and keep progress and results in the original work thread.

A routine question or status-only message does not hand work back or authorize resumption. While main owns the work, an explicit instruction to hand it back must reach the lead conversation or main session. Keep the original work thread for progress and results; use `dori reopen`, not a bare session restore.

`dori reopen` starts the exact saved OMP session in a new pane and verifies its live identity. If the native goal is paused, it confirms `/goal resume` through extension state. The session can also reopen with no goal or with a completed or dropped goal, so a successful reopen alone does not prove a native goal is active. It preserves the original thread, Done signals and history, clears the old claim/receipt, and starts a new supervision interval. A missing saved session or working directory, existing old pane, already-running session, or non-OMP command refuses reopening. An advanced `agentCommand` must end in a positional `{prompt}` and contain no preselected session. A startup/readback failure leaves one registered paused lane for inspection, never silently starts another. A failed start that left a confirmed bare shell can be ended with `close --abandon --reason TEXT`, then explicitly reopened; a foreign or unverified agent still holds. Ordinary `resume` verifies the recorded session identity before sending input. An optional note is sent once; exit 3 can mean its delivery is unconfirmed, so never repeat it automatically.

## Pause, park and abandon

- `pause` / `resume` retain their existing short-wait behavior: keep the pane and verify native goal state.
- `dori park <key> --note TEXT [--resume-when TEXT]` is long-term suspension for an OMP lane. It verifies the exact saved session and goal pause before closing only that lane's pane, keeps all worktrees (including unpushed work), and records `status: closed` with `receipt.outcome: parked`, not a successful completion. An unconfirmed pause or failed pane close leaves the lane open/paused and exits 3.
- `dori close <key> --abandon --reason TEXT` explicitly ends unfinished work without claiming Done. It pauses a live working/not-done lane before closing its pane, or records an already absent pane. Worktrees are retained and the receipt says `abandoned`. Both terminal operations accept working, not-done or paused lanes; a pending done claim must first be resolved. Neither runs `threadDone`, removes worktrees, or creates a success lesson. Ordinary `close` still checks every Done signal and records `outcome: done`.
- Both terminal commands hold before pausing or closing a native lane while its accepted Discord messages are still pending. Parking or abandoning a live OMP agent also requires its previously recorded session identity; inspect and bind the correct session with `dori sync --write` before proceeding if it is unbound.
- `dori holds [--thread REF]` and `dori boot` show paused/parked lanes with their reasons and resume conditions. Conditions are descriptive; passing time or a prerequisite never resumes the lane. Only an explicit `resume` or `reopen` does. A parked lane does not count as open, and the normal done watcher does not settle it.
- Parked and abandoned lanes do not count as completed samples in `dori eta`.

Parking records the saved session, original reason and resume condition before closing the pane. If interrupted after that close, repeating the same terminal command finishes the stored intent without replacing its reason or condition. For an interrupted park, `dori reopen <key>` instead restores the same saved session when its old pane is absent, including when accepted Discord work must still be delivered. It never discards that work to finish parking.

Reopening uses the delivery lock shared with pause, resume, tell and close. Concurrent reopen attempts cannot create two agents. Older completed lanes can resolve an exact recorded session ID in `sessionsDir` when no path was saved. Deleted completed worktrees are not recreated implicitly. The reopened registry generation starts current progress afresh, even if writing the reopen journal event is interrupted. Old reports and cost receipts remain on disk.

`dori sync --write` still reports identity drift; it cannot replace the exact binding of a prepared or reopened lane.

Ordinary Done close of a reopened lane verifies the saved session's current foreground and records the close intent before removing its pane. Objections can still win before the intent is recorded. After that point, another claim, objection or delivery cannot change that decision. If pane-close readback is interrupted, retry `dori close` or let the active Done watcher confirm the saved intent. A missing pane without a saved intent is not treated as a completed close.

## Messaging a session

Before you type into a pane:

1. check it runs a live agent (`herdr pane process-info --pane <id>` / `hc get <t>`), not a shell, a stopped agent or a startup screen;
2. read it (`herdr pane read <id> --source recent-unwrapped --lines 40` / `hc read <t> --lines 40`) and confirm the input line is empty and no approval or question prompt is open;
3. send once, as one argument (the scripts' `sendVerified` does this);
4. confirm delivery from a state change: the agent's status moving to working (herdr's `agent_status`, or the status the agent reports on hc), or the message showing up in the session record. Never press Enter again because of what the screen shows; if no change shows up, treat the send as unconfirmed.

Exit code 0 and echoed input are not proof the agent got the message. A reply from the session, or its record of handling the message, is.

For a registered lane, `dori tell <key> --text TEXT` does steps 1, 3 and 4 through `sendVerified`; the runtime's delivery holds on an open OMP approval or an unknown status. `TOLD` (exit 0) means the agent moved to working. `TELL_UNCONFIRMED` (exit 3) means the text may be in the session but no status change was seen, which is always the case for an agent that was already working: do not send it again; wait for the lane to answer, or read the pane (step 2) and, if the text still sits in the input, press Enter only. `TELL_FAILED` (exit 2) means nothing was sent: a shell, a stopped agent, an approval prompt, an unreadable status, on hc a `blocked` or `error` agent (answer its question in the pane), a paused lane (resume it first), a lane without a session, or text with a backtick or `$(`; a refusal by the runtime ends with the status read after it. An unknown or closed key exits 1.

## Watching

- Sessions that turn blocked or ask a question: answer them or bring them to the owner.
- Sessions that report a bug: reproduce it before it counts, then give it its own thread.
- `dori dead-panes` reports agent sessions that stopped. Restore a stopped agent's recorded OMP session with `omp --resume=<id>` only for unfinished work that still belongs to that lane under the owner's open request. This is process recovery, not `dori reopen` for a closed lane. If recovery restores a paused goal, report the held work and wait for the user's explicit resume instruction.
