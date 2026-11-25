# Sessions (lanes)

A lane is one tracked agent session doing one job. On macOS and Linux it normally runs in native OMP under a local supervisor, without a terminal. With the optional Tern terminal runtime it runs in a Tern tab. Launch it, track its registry entry, answer it when stuck, and close it when its work is proven done.

## Launching

```sh
cataly launch fix-login --title "Fix the login redirect loop" \
  --brief ~/briefs/fix-login.md --done "merged acme/app#412; closed acme/app#398" \
  --thread "telegram:<chat>/<topic>" --model anthropic/claude-opus-5-5
```

For headless lanes, `launch` validates the key and `Done =` signals, adds the lane footer, and starts its own OMP RPC session. `STARTUP_OK` requires the exact native session, a matched provider/model and a confirmed native goal. `STARTUP_UNCONFIRMED` leaves the launched identity inspectable instead of retrying. Use `cataly headless observe <key>` to see its output and pending dialogs.

For a Tern launch, `launch` checks the key and the `Done =` line, appends a footer to the brief, opens a tab in the lead's Tern session (or the session `laneWorkspace` names), starts the agent, and after 20 seconds checks the start: `STARTUP_ERROR` on a known failure (missing module, no API key, rate limit, quota), also when one shows on an idle agent during the goal wait, `STARTUP_OK` only when the runtime reports the agent idle or working and it shows a goal (checked again every 10 seconds until `startupWaitSeconds`, 180 by default, after the start; an agent that has not reported a status yet is waited for too), `STARTUP_NO_GOAL` when it still shows no goal after that, `STARTUP_DONE <key>` when the session is gone and the lane already finished (closed, verified-done or reported done; exit 0, nothing to do), `STARTUP_UNCONFIRMED` otherwise. On `STARTUP_ERROR`, relaunch on another model; on `STARTUP_NO_GOAL`, tell the lane to set its goal, since a lane without one stops after its first turn; on `STARTUP_UNCONFIRMED`, look at the block before doing anything else.

Write the brief like a careful prompt:

- open with the instruction you would type yourself (for example `set goal and work`);
- the original request/source references and only the facts learned that matter to this task, not the whole lead transcript;
- the allowed repositories, worktree and branch, with the execution directory explicit when it differs from the lead's;
- the observable acceptance, checks and stop condition, from the point of view of whoever uses the result;
- resources and user changes to preserve, unfinished external effects and their receipts, and the latest resume checkpoint;
- the work thread, how to report, and a deadline only if one actually exists.

On a follow-up or resume, read the brief, registry and existing checkpoint history before acting. Keep the original source, allowed repository/branch, acceptance and report route unless the lead explicitly changes the assignment; another session's cwd or an unrelated message is not such a change. The launch footer repeats recorded locations, but those paths grant no additional authority. If a material field is missing or conflicts with live state, resolve it with the lead before the affected work rather than inventing values, permissions or deadlines. Inspect uncertain external effects by their receipts before repeating them.

**Why the `Done =` line has to be checkable:** the watcher closes lanes on its own, so it can only trust what it can read back itself. `launch` and `adopt` refuse any signal outside this list. Signals are joined with `;`, and every one has to pass.

| Signal                                                | Passes when                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `merged <owner/repo>#N`                               | the PR is merged and has a merge commit                                              |
| `closed <owner/repo>#N`                               | the issue is closed                                                                  |
| `published <pkg>@<version>`                           | npm has that exact version                                                           |
| `command ["argv","as","json"] [stdout~"regex"]`       | the command exits 0 when the watcher runs it, and stdout matches if a regex is given |
| `file <path> [sha256=<hex>] [json:.a.b=<json value>]` | the file exists, its sha256 matches, and the JSON field equals the value             |
| `url <http(s) url> [status=200] [body~"regex"]`       | a GET returns that status, and the body matches if a regex is given                  |

The last three are for work that never lands as a PR: a local setup, a QA pass, a running service. Write the check so that it can fail. `command ["bun","test"] stdout~" 0 fail"` is a real check, while `command ["true"]` checks nothing. The watcher runs commands itself, in the lane's directory, as a plain argv with no shell. They have a 2-minute limit. It never trusts the lane's own report that something passed. Relative file paths resolve from the lane's directory, and `~` is your home. JSON values compare as JSON, so `json:.n=3` and `json:.n="3"` are different checks.

Example for a QA-only lane:

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

Work no script can check (a design review, a judgement call) stays in the lane's own plan. You judge it yourself before the claim.

## Templates and prerequisite queues

Store local Markdown templates under `templates/` beside `CATALY_CONFIG` (normally `~/.cataly/templates/`). `{{name}}` inserts a required literal variable; `{{>common}}` includes `common.md` from the same directory. Includes may nest, but cycles, missing variables, invalid names and symlink escapes are refused. No shell or template code is evaluated.

```sh
cataly launch deploy-beta --title "Deploy the verified build" --template deploy \
  --set branch=main --set target=beta --done "file /srv/reports/deploy-beta.json json:.passed=true" --dry-run
cataly launch verify-build --title "Verify the finished build" --brief ~/briefs/verify-build.md \
  --done "closed acme/app#412" --after build-app --expires-hours 24
cataly queue list
cataly queue start verify-build
cataly queue cancel verify-build
```

`--template` replaces `--brief`; repeated `--set name=value` supplies variables. `--dry-run` prints the rendered brief and footer without writing files, registering a lane, queueing or opening a session. `queue start` and `queue cancel` reject `--dry-run`. An actual template launch creates a new brief at `<stateDir>/briefs/<key>.md` without overwriting existing files or following an output link. Explicit `--brief` files retain their existing behavior.

Before opening a session, Cataly stages generated text in a private attempt directory beside the intended brief. It creates the usual brief path only after the runtime returns an identity, and never replaces an existing path. A confirmed creation rejection clears only the private attempt. If creation is uncertain, Cataly keeps the attempt and holds an immediate retry; inspect the recorded path and live session first. A queued attempt still requires explicit cancellation and a fresh reservation before any retry.

`--after a,b` snapshots the prepared brief and its effective absolute working directory in `<stateDir>/launch-queue/` and reserves its lane key without starting an agent. `--cwd` overrides the enqueue-time default. Older reservations missing `cwd` still use the default at start time; inspect them with `queue list` and cancel and requeue with `--cwd` if the original directory matters. Predecessors must already be known lanes or queue entries; cycles and self-dependencies are refused. The default expiry is 24 hours. `queue list` and `boot` preserve visibility after a restart; `watch` emits a changed `LANE_QUEUE_READY`, `LANE_QUEUE_HELD` or `LANE_QUEUE_WARN` notice but **never starts a queued lane**. Readiness is based only on stored status/receipt/expiry, not permission to run: watch never executes Done commands or host probes. Damaged queue files are reported separately by list/boot/watch without hiding valid entries; list and boot return nonzero for that damage.

The working directory must exist when enqueued. Cataly follows symlinks and `..` in filesystem order and stores the resulting directory.

Starting rechecks every predecessor's closed status, successful normal-completion receipt and live Done signals, then current host capacity and expiry. A changed predecessor generation or completion receipt holds the start. Paused, parked, abandoned or merely claimed lanes are not completion. A queue snapshot does not track later brief/template edits. Expired entries require explicit cancellation and a reviewed new queue request. No worktree or running agent is removed by cancellation.

Starts are serialized with immediate launch/adopt for the same key, independently of pause/tell delivery so startup checks cannot block an operator interruption. Different queued keys sharing the state directory serialize the host-capacity check through session creation, not startup confirmation. Dependency graph updates are serialized across keys to prevent concurrent requeues from adding a cycle. A durable `starting` record precedes session creation; a crash or uncertain startup never triggers an automatic retry. Inspect the registry and owning runtime: cancellation can release an unregistered attempt, but a registered lane must use its ordinary lifecycle controls. A `started` receipt means the launch attempt was recorded, not that the goal finished; inspect the printed `STARTUP_*` result.

## Lane Bash policy (opt-in)

`lanePolicy` in Cataly's configuration adds Bash tool-call rules to new native lanes:

```json
{
  "lanePolicy": {
    "denyBash": ["\\bsudo\\b"],
    "perLane": { "docs-*": { "allowBash": ["sudo -l"] } }
  }
}
```

Lane globs support `*`; other accepted glob characters are literal. Deny expressions search the command string, while an exception has to match the whole command string. Malformed rules fail configuration validation. With no lane policy, ordinary launches are unchanged.

The policy requires fresh, unambiguous OMP argv with one `--cataly-role lane`. The launch writes its private snapshot after registering the lane and before starting OMP. Dry-run writes nothing and adoption does not retrofit a policy. The extension records the bound snapshot generation in the native transcript, restores it on resume and `/new`, and inherits it through subagents. A protected subagent needs a persisted parent session. A missing or unreadable binding is not a reason to let a protected Bash call run.

A blocked call records the rule IDs and the command's SHA-256, not the command text. After the owner approves the exact blocked command, the owner or lead may record one attempt from outside the protected session:

```sh
cataly policy allow-once demo-lane 'denyBash[0]' --reason "Owner approved the blocked attempt"
```

For a lane started by the root harness, pass `--root headless:<UUID>`, or the
unique prefix `cataly harness status` shows for that lane (`headless:3f2a9c1e`);
an ambiguous or unknown prefix is refused. If a skill-registry lane and a root
lane share a key, use `--skill` to select the skill-registry lane instead.
The key alone cannot authorize a different lane with the same name.

Every matching deny rule needs its own grant. An unused grant is idempotent; a grant is consumed for one attempt, even if OMP's independent approval gate subsequently declines it. This command sends or executes nothing. The lane must explicitly retry.

This policy is a local guardrail, not a sandbox or another authorization service. It sees the native Bash tool's command string, not script contents or all possible execution routes. Keep the native approval and OS account boundaries in place.

## The registry

One JSON file per lane under `<stateDir>/lanes/`, written atomically (temp file + rename), so two writers never leave a half-written file. Each lane records:

| Field                           | Meaning                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread`                        | where its updates go, as `platform:thread` (or `none`)                                                                                                                       |
| `sessionRef`                    | its session: the runtime (`headless` or `tern`), the id, and the group (the headless group label, or the Tern session) and tab when the runtime has them |
| `session`                       | the agent's own session id, so a closed job can be reopened later                                                                                                            |
| `status`                        | `working`, `done-claimed`, `verified-done`, `not-done`, `closed`                                                                                                             |
| `claim`, `objection`, `history` | what was claimed, what was objected, every status change                                                                                                                     |

`cataly sync` compares the registry with live sessions and prints drift (a session that is gone, a session id that changed, an empty `Done =` line). It never deletes anything. With `--write` it stores the session ids it found.

How the session id is found for a session, in order:

1. the role-gated OMP extension's record under `<stateDir>/sessions/<encoded runtime id>.json`, trusted only when its PID belongs to the current session's live agent process;
2. an OMP session file in `sessionsDir` whose timestamp matches that process, using OMP's temporary, home-relative and legacy directory encodings.

The extension updates its record when the agent switches sessions. A stale PID, wrong session or approval-pending record never becomes permission to send to or type into another process; unknown status stays held.

When work is assigned back to a closed lane, use `cataly reopen <key> [--note TEXT]`. A reply in the original work thread is not a hand-back while main owns that work. Keep the lane closed until main hands it back. During main ownership, send new instructions to the lead conversation or main session, and keep progress and results in the original work thread.

A routine question or status-only message does not hand work back or authorize resumption. While main owns the work, an explicit instruction to hand it back must reach the lead conversation or main session. Keep the original work thread for progress and results; use `cataly reopen`, not a bare session restore.

`cataly reopen` starts the exact saved OMP session in a new headless session and verifies its live identity. If the native goal is paused, it confirms `/goal resume` through extension state. The session can also reopen with no goal or with a completed or dropped goal, so a successful reopen alone does not prove a native goal is active. It preserves the original thread, Done signals and history, clears the old claim/receipt, and starts a new supervision interval. A missing saved session or working directory, a still-live old session, an already-running session, or a non-OMP command refuses reopening. An advanced `agentCommand` must end in a positional `{prompt}` and contain no preselected session. A startup/readback failure leaves one registered paused lane for inspection, never silently starts another; a foreign or unverified agent holds. Ordinary `resume` verifies the recorded session identity before sending input. An optional note is sent once; exit 3 can mean its delivery is unconfirmed, so never repeat it automatically.

## Pause, park and abandon

- `pause` / `resume` retain their existing short-wait behavior: keep the session and verify native goal state.
- `cataly park <key> --note TEXT [--resume-when TEXT]` is long-term suspension for an OMP lane. It verifies the exact saved session and goal pause before closing only that lane's session, keeps all worktrees (including unpushed work), and records `status: closed` with `receipt.outcome: parked`, not a successful completion. An unconfirmed pause or failed session close leaves the lane open/paused and exits 3.
- `cataly close <key> --abandon --reason TEXT` explicitly ends unfinished work without claiming Done. It pauses a live working/not-done lane before closing its session, or records an already absent session. Worktrees are retained and the receipt says `abandoned`. Both ending operations accept working, not-done or paused lanes; a pending done claim must first be resolved. Neither runs `threadDone`, removes worktrees, or creates a success lesson. Ordinary `close` still checks every Done signal and records `outcome: done`.
- Both ending commands hold before pausing or closing a native lane while its accepted Discord messages are still pending. Parking or abandoning a live OMP agent also requires its previously recorded session identity; for an unbound Tern lane, inspect and bind the correct session with `cataly sync --write` before proceeding, and otherwise inspect it with `cataly status <key>` first.
- `cataly holds [--thread REF]` and `cataly boot` show paused/parked lanes with their reasons and resume conditions. Conditions are descriptive; passing time or a prerequisite never resumes the lane. Only an explicit `resume` or `reopen` does. A parked lane does not count as open, and the normal done watcher does not settle it.
- Parked and abandoned lanes do not count as completed samples in `cataly eta`.

Parking records the saved session, original reason and resume condition before closing the session. If interrupted after that close, repeating the same command finishes the stored intent without replacing its reason or condition. For an interrupted park, `cataly reopen <key>` instead restores the same saved session when its old session is absent, including when accepted Discord work must still be delivered. It never discards that work to finish parking.

Reopening uses the delivery lock shared with pause, resume, tell and close. Concurrent reopen attempts cannot create two agents. Older completed lanes can resolve an exact recorded session ID in `sessionsDir` when no path was saved. Deleted completed worktrees are not recreated implicitly. The reopened registry generation starts current progress afresh, even if writing the reopen journal event is interrupted. Old reports and cost receipts remain on disk.

Ordinary Done close of a reopened lane verifies the saved session's current foreground and records the close intent before closing its session. Objections can still win before the intent is recorded. After that point, another claim, objection or delivery cannot change that decision. If session-close readback is interrupted, retry `cataly close` or let the active Done watcher confirm the saved intent. A missing session without a saved intent is not treated as a completed close.

## Messaging a session

Before you send to a session:

1. check it runs a live agent with no open approval or question (`cataly status <key>`, `cataly headless observe <key>` for a headless session's status and pending dialogs, or `tern process <block>` for what runs in front of a Tern block), not a shell, a stopped agent or a startup screen;
2. on a Tern block, read it (`tern capture <block> --scrollback`) and confirm the input line is empty;
3. send once, as one argument (the scripts' `sendVerified` does this);
4. confirm delivery from the native host's answer or a state change: the agent's status moving to working, or the message showing up in the session record. Never press Enter again because of what a screen shows; if no change shows up, treat the send as unconfirmed and never send it again.

Exit code 0 and echoed input are not proof the agent acted on the message. A reply from the session, or its record of handling the message, is.

For a registered lane, `cataly tell <key> --text TEXT` does steps 1, 3 and 4 through `sendVerified`; delivery holds on an open OMP approval, an unknown status or a changed session id. `TOLD` (exit 0) means the native host confirmed delivery to the exact recorded session, queued if the agent was working, or on tern that the agent moved to working. `TELL_UNCONFIRMED` (exit 3) means the text may be in the session but delivery was not confirmed (the host's answer was lost, or on tern no status change was seen, which is always the case for an agent that was already working): do not send it again; wait for the lane to answer, inspect it with `cataly headless observe <key>`, or on tern read the block (step 2) and, if the text still sits in the input, press Enter only. `TELL_FAILED` (exit 2) means nothing was sent: a shell, a stopped agent, an open approval, an unreadable status, a paused or parked lane (resume or reopen it first), a lane without a confirmed session, or a changed lane identity; a refusal by the runtime ends with the status read after it. An unknown or closed key exits 1.

An unconfirmed dispatch now keeps a private, durable local request ID. It fences later `tell` messages, automatic nudges, and claim/objection notifications even after restart; a rejected later message is not queued. `cataly tell <key> --status` shows that record. Only `cataly tell <key> --resolve REQUEST_ID --note REASON` ends that exact hold: it does not prove the action ran, cancel the original input, or resend anything. Inspect the original session and obtain the operator's decision before releasing it. Ordinary activity cannot clear a hold. Explicit pause/resume remains available, and releasing a hold does not resume a paused lane. See the scripts reference for statuses, errors and concurrency.

This hold covers Cataly automation, not direct native owner input. Native Discord owner messages and native ASK replies retain their existing admission rules so the owner can still control the session. They do not release the uncertain record; later tells, nudges and claim/objection notices remain held until an exact-ID release. Explicit `reopen --note` is also operator control: it attempts the note once under its existing session/goal checks without creating or clearing a `.delivery` record. An unconfirmed reopen note is not resent automatically.

## Watching

- Sessions that turn blocked or ask a question: answer them or bring them to the owner.
- Sessions that report a bug: reproduce it before it counts, then give it its own thread.
- `cataly boot` and `cataly sync` report lanes whose session is gone (`VANISHED`, `DRIFT`); the registry record and worktrees are kept. On tern, `cataly dead-panes` also reports agent blocks that stopped. Recover a stopped agent's recorded OMP session (`omp --resume=<id>`) only for unfinished work that still belongs to that lane under the owner's open request. This is process recovery, not `cataly reopen` for a closed lane. If recovery restores a paused goal, report the held work and wait for the user's explicit resume instruction.
