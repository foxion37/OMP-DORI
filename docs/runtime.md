# Session runtimes: headless OMP and Tern

On macOS and Linux the default is headless OMP: Cataly runs the lead, duty and
lanes as native OMP sessions, and the two scheduling loops as local processes. No
terminal server is required. Tern is the optional terminal runtime (a source
feature outside the consumer release path): it gives sessions, tabs and blocks
and reports the program in front of a block. Registered sessions keep their
owning runtime. The headless host needs a Unix socket, so on Windows only Tern
can run sessions.

Every headless session has its own detached host process under
`<state>/headless/<uuid>/`. For the lead, duty and lanes it is the native
Cataly binary, `cataly headless-host <dir>`: it owns the OMP `rpc-ui` child,
the owner-only Unix socket the CLI and extension talk to, and the
`stopped.json` receipt. The two scheduling loops, `duty-loop` and
`hourly-loop`, are Bun processes (`src/runtime/headless-loop.ts`) with no OMP
child. The CLI picks the binary in this order, never from the current directory
or `PATH`:

1. `CATALY_DISCORD_NATIVE_BIN`, when it is an absolute path;
2. the binaries of the code tree the CLI runs from, same commit by
   construction: the release-bundled `native-bin/<platform>-<arch>/cataly`,
   then `target/managed/release/cataly`, which only a managed source
   deployment writes (it runs `cargo build --locked --release --bin cataly`
   while preparing the release, before anything stops, and holds when Rust is
   missing or the build fails). A developer's own `target/release` build is
   never used; point the override at it instead;
3. the installed `$CATALY_HOME/bin/cataly-native`, where `CATALY_HOME` defaults
   to `~/.cataly`.

Without any of them, starting a lane, the lead or duty fails with the
[reinstall guidance](releases.md#troubleshooting-and-support-reports). A host
that exits before proving startup is named in the error with its path, so an
old build without `headless-host` is visible; rebuild or reinstall it. A binary
built for another `native-omp.lock` refuses the OMP version and reports that
instead.
`CATALY_DISCORD_NATIVE_BIN=off` disables only the Discord-native features; the
headless host still resolves through steps 2 and 3. A Discord lane wake starts
its host from the running Discord monitor binary itself.

The [release guide](releases.md#support-boundary) lists the current install
profiles. Cross-OS CI does not by itself establish live consumer support.

The primary installed `cataly` remains the skill CLI. Every root harness command here uses `cataly harness ...`; `cataly-harness ...` after root linking or `bun src/cli.ts ...` are equivalent entrypoints. For example, skill `cataly send discord` posts to a messenger, while `cataly harness send lead` sends to an agent session.

Lead and duty start OMP with role `cataly`; lanes and the built-in reviewer use role `lane`. Managed deployment and source-side wrappers pass a complete JSON string array through `CATALY_AGENT_ARGV`. The harness quotes each argument for shell execution; the skill preserves the selected prefix and configured template suffix for installer-owned defaults, including their lexical and canonical installation paths. Managed commands retain their native config fence and pinned Cataly extension. Explicit external commands remain intact. Without a managed selection, the harness retains `CATALY_AGENT_CMD` as a user shell command, defaulting to `omp`. The skill configures its own argv template and default model separately; see the [skill configuration reference](../skills/cataly-mode/references/scripts.md#configuration). The extension and full sibling source layout must be installed together; the release installer provides that layout because the skill imports these runtime adapters by sibling path.

New sessions receive the selected `HOME`, `CATALY_CONFIG`, `CATALY_HOME`, `CATALY_STATE_DIR` and `CATALY_AGENT_ARGV` explicitly, plus their own `CATALY_HEADLESS_ID`. Relative paths become absolute without collapsing symlinks or `..`. Fresh sessions clear `CATALY_MANAGED_STARTUP`. Initial launches, reviewer children and native resume keep this context without forwarding arbitrary parent variables.

Source installation holds when its selected native executable aliases a wrapper that the chosen install mode will overwrite. File identity checks cover direct paths, symlinks, aliased parents and hard links without reading wrapper contents. Explicit overrides are checked before their version probe or installation changes; a bundled native selection is checked as soon as it is available.

The native selection must also avoid traversing a command symlink that installation will replace: the primary `cataly` link or side `omp-cataly` link. This check follows relative links, parent aliases and directory prefixes without rewriting the selected pathname. Independent paths to the same executable remain valid because relinking leaves their target inode intact.

Managed release preparation runs Git materialization and frozen dependency installation with a child-local `umask 077` before bundle admission. Root and skill packages use `--production`; the extension retains its full frozen install, including the OMP host dependency. The caller's mask stays unchanged, and independently group/world-writable bundle files remain rejected.

Source-native preparation builds the export viewer with the pinned upstream builder's `--check` mode after frozen dependency installation. The generated filename, size and SHA-256 must match the tracked viewer manifest without rewriting it. Native cache admission and launch require that exact owned asset; missing, modified, writable or additional assets hold admission.

Process attestation also recognizes the pinned launcher's optional `PI_TIMING=1` preload from the same source tree. The timing module must occupy its exact additional preload position; arbitrary, foreign, reordered or duplicate preloads remain untrusted. Session, ancestry, process-start and approval checks still apply.

## The interface

`SessionRuntime` in `src/runtime/types.ts` covers session creation, observation, delivery and close. The headless host takes `self()` from `CATALY_HEADLESS_ID`, starts OMP by argv and operates its native goal and dialogs over RPC. Only `TerminalRuntime` supports workspace creation, starting a shell command, submitting typed text, typing into a shell and sending keys; the following table describes the tern adapter in `src/runtime/tern/`. It runs its CLI through one injectable process runner (`src/runtime/exec.ts`), so tests replace the binary with a recorder.

| Method | What it does |
|---|---|
| `self()` | The caller's own session, from `TERN_PANE` |
| `createGroup(label, cwd)` | The caller's own Tern session id, else the label; nothing is created |
| `create(spec)` | A session with the user's shell in it and nothing started |
| `start(ref, command)` | Runs the command line in that shell |
| `list(filter)` | The live sessions, all of them or one group's |
| `probe(ref)` | One snapshot: status, agent name, foreground processes, title, cwd |
| `read(ref, lines)` | The last lines of the screen |
| `deliver(ref, text, opts)` | One message to the agent; never types into a shell |
| `submitTyped(ref, into)` | Presses only Enter for text an earlier delivery typed |
| `typeIntoShell(ref, text)` | The operator's `--to-shell`, only into a session with no agent |
| `keys(ref, keys)` | Enter or Escape |
| `close(ref, scope)` | Closes the session (a Tern tab closes with its last block) |

A session is stored as a `SessionRef`: the runtime (`headless` or `tern`), the id (a decimal block id such as `42` on tern), and the group and tab when the runtime has them. Every stored lane and role keeps its own ref, so commands on an existing session go to the runtime that opened it, whatever runtime is selected for new sessions.

## Choosing a runtime

For new sessions, `CATALY_RUNTIME` overrides the configuration field `sessionRuntime`; both accept `headless` and `tern`. With neither set, macOS and Linux select `headless` even inside a Tern block or when `tern` is installed. `cataly harness status` reports `RUNTIME headless (from default)`. A `runtime` field alone does not opt a home into terminal execution.

An explicit `launch --runtime` overrides the lane and session settings for that launch. With `"laneRuntime": "terminal"`, and on Windows where the native host has no Unix socket, the terminal runtime is Tern when the `runtime` field says `"tern"`, the caller runs in a Tern block (`TERN_PANE`), or `tern` is on `PATH`. When none of these holds, commands that require a terminal refuse with a one-line fix: install Tern, or set `"runtime": "tern"` in the config file (the message prints its absolute path), or `CATALY_RUNTIME`.

Any other value of `CATALY_RUNTIME` or `sessionRuntime`, or a `runtime` other than `tern`, is an error. `cataly harness status` prints the choice first, for example `RUNTIME tern (from config)`; sources are `default`, `env`, `config`, `detect:TERN_PANE` and `detect:path`. With no choice it prints `RUNTIME unset:` and a fix. Skill `cataly boot` prints the same selection, or `RUNTIME unavailable:` and a failed check.

After the roles, `cataly harness status` lists the open lanes, the longest without progress first, one line each within 120 columns: key, status, session ref, progress and the last entry. The ref names its runtime once, as its prefix. A headless id is shortened like a git short SHA: its first 8 characters, more when another registered session (a role or a lane of any status) shares them:

```text
discord-intake        waiting  headless:3f2a9c1d-11 progress 40m (14:20)    waiting: ci:vntrevx/Cataly#812 since 14:25
docs-license          working  tern:42              progress 25m (14:35)    report 14:35: license headers added
status-board-readable working  headless:3f2a9c1e    progress 12m (14:48)    report 14:48: rebased on main; touched suit…
discord-voice         working  headless:3f2a9c1d-12 progress 5m (14:55)     report 14:55: voice route test green
```

Commands that take a session ref accept the shortened form and resolve it against the registered roles and lanes: `cataly harness send`, `inbox list|ack|resend`, `observe` and `answer`, and skill `cataly policy allow-once --root`. A prefix shorter than 8 characters, one no registered session has, and one more than one has are refused; an ambiguous one lists the full refs it matches. The roles line, `NATIVE` lines, JSON output and stored records keep the full id.

For a registered native lead or duty session, use `cataly harness observe lead`
or `cataly harness observe duty`. To stop the owned native harness, run
`cataly harness stop`; busy or blocked agents hold rather than being forced
closed.

On the headless runtime, `cataly harness stop` records the lead's OMP session and
transcript (`harness-lead.json` in the Cataly home). The next `cataly harness up`
resumes that lead session when the stop closed exactly that session cleanly and
its transcript still exists, and prints `resumed=<sessionId>`; the new lead must
prove the same session before it is registered. A lead that exited on its own,
or a missing transcript, starts a fresh session. `cataly harness up --fresh`
always starts a new lead session. Duty and the two loops always start fresh. A
managed deployment uses the same resume and requires it: its restart refuses
rather than replace the lead's session.

## Tern

Tern (`tern`, checked against 0.9.28) is a terminal whose daemon keeps programs running between windows. A Tern session holds tabs and a tab holds blocks. A Cataly session is one block: its ref is `tern:<block id>` (decimal, such as `tern:42`), its group the Tern session id and its container the tab id. A Tern session therefore groups a home's sessions, and the adapter adds no config key or environment variable of its own.

| Used for | tern call (every call carries `--json`, placed before `--` when the call has one) |
|---|---|
| The lead on `cataly harness up` | `new session <free name> --cwd D -- env PI_TUI_NATIVE=0 K=V ... $SHELL` (`cataly`, else `cataly-2`, ...) |
| Duty and lanes | `new tab <session id> --cwd D -- env ...`, or `new session <name> ...` when no session has that name yet; then `rename <block> <name>` names the tab |
| The duty loop and the hourly loop | `split <near block> down --cwd D -- env ...` |
| Starting the agent or loop, `--to-shell` | `run <block> -- <command>` (types it and Enter) |
| Probe | `inspect` (the block, whether it is live, Tern's busy flag) and `process <block>` (foreground, process group, the block's root pid) |
| Screen reads | `capture <block> --scrollback`, trailing blank rows dropped; unwrapped joins rows as wide as the block |
| Delivering a message | `send <block> paste -- <text>`, then `send <block> keys enter` |
| Enter, Escape | `send <block> keys enter` / `esc` |
| Closing a session | `close <block>`; `no block is called` means it is already closed |
| Listing | `inspect`, then `process` for each live terminal block |

A tab opens in the session its spec names (a Tern session name or id), else in the Tern session holding the caller's own block (`TERN_PANE`), else in a session named `cataly`. The skill passes `laneWorkspace` as that name, so on tern `laneWorkspace` is a Tern session; unset, a lead running in Tern opens its lanes as tabs beside itself. A name no session holds yet is opened with the first tab; a numeric id that names no session is refused, because Tern would open a session called by that number.

`list()` with a group returns that Tern session's live terminal blocks, and without one every live terminal block of the window, the user's own blocks included. Set the skill's `workspaces` to the lane session on tern so `sync` and `dead-panes` read only that session. Every `tern` command works on one window's sessions (the window holding `$TERN_PANE`, else the first window), so run Cataly from a Tern block or use one window.

### Status and the classic UI

Tern reports the foreground process and a busy flag, not agent status words. A shell in front is `shell`. An OMP process in front is `working` while Tern's busy flag is set, else `idle`. Any other program is `unknown` and never receives input. With the configured `stateDir`, the attested OMP record refines this (identity, an open approval as `blocked`, its idle/working word), and an OMP in front with no record of its own reads `unknown`. The extension writes that record under `TERN_PANE`.

OMP in a Tern block normally draws its UI natively over the Tern Surface Protocol, and `tern capture` then shows neither its input nor its dialogs. Every block Cataly opens sets `PI_TUI_NATIVE=0` (a spec env may override it), so OMP draws its classic terminal UI and its input can be read. Start a lead by hand the same way.

### Delivery

Tern has no call that prompts an agent, so the adapter types: it pastes the text as one bracketed paste (a line break never submits early) and presses Enter. The probe gates first, as on headless: a shell or a gone block is `no-agent`, an approval is `blocked`, and an unknown status or one `when` does not accept holds the message. Then the screen decides how much the adapter can check:

- The classic OMP input is recognised (a row starting `╰─` right under the status row, or the older omo box) and reads empty: the text is pasted, Enter is pressed only while a draft is seen there, up to three times, and the delivery counts once the input reads empty again. Text that stays in the input is `typed`, for `submitTyped` to finish with Enter only.
- The input is recognised and holds a draft: the message is held. Cataly does not write over what a person is typing.
- No input is recognised (a natively drawn OMP, another composer, a dialog the probe does not report): the adapter pastes, checks that the same agent is still in front, and counts one accepted Enter as the delivery. It cannot see whether that Enter submitted the text.

A paste that fails may have typed part of the text and is `ambiguous`; it is never resent. `submitTyped` reports `changed` when the agent is another one or its recognised input reads empty.

A delivery bound to one native session (`expectedSessionId`) is held as `unknown` unless the attested record names that session.

The extension's Discord routes for a lane's own session (owner chat delivered to the lane and automatic ASK forms) find a lane in a Tern block through `TERN_PANE`.

## Status

Cataly reads a session's status before it delivers anything. The words are `idle`, `working`, `blocked`, `done`, `error`, `unknown`, `shell` and `gone`.

For a known idle/working native state, the attested OMP lifecycle record can refine the current state independently of native goal status. Native done stays done after identity and approval checks. A status mismatch leaves the batch queued.

Skill direct sends gate on the status they just read. A rejected send is failed; an ambiguous or working-turn delivery is unconfirmed and is not resent automatically. Force can bypass native blocked/error status, but never a process-bound OMP approval hold.

### OMP identity, goal and approval records

The extension writes `<stateDir>/sessions/<encodeURIComponent(id)>.json` for its headless session id (`CATALY_HEADLESS_ID`) or, in a Tern block, its `TERN_PANE`. Its schema is `paneId` (the session or block id), `role`, `sessionId`, optional `sessionFile`, `cwd`, `pid`, `startedAt`, `updatedAt`, `goal: {status, objective?}`, `approvalPending`, optional `agentStatus: idle|working`, and optional `native: {observedAt, jobs, approvals}`. `stateDir` follows `CATALY_STATE_DIR`, then the `CATALY_CONFIG` file's value, then `~/.cataly/state`. Production callers pass that configured `stateDir` explicitly to enable OMP refinement. Runtime instances without it preserve native behavior and do not read operator config or extension state.

The runtime attests the writer against the live session process, its ancestry and process start time before trusting a record. Missing, malformed, reused-pid, foreign or changing OMP identity stays unknown; an open approval becomes blocked even for forced delivery. Session IDs and files therefore come from the live OMP writer rather than an unrelated newest transcript.

Native goals remain agent-owned. Skill pause/resume reads back active/paused state before committing its registry transition and reports exit 3 when unverified. Budget-limited and unknown native goal states map to blocked, never no goal. Resumed roles persist, but a resumed native goal can be paused and need `/goal resume`. The `cataly` role's recorded monitor specs can restore on that session's resume; fresh installation and default container startup do not start any messenger or watcher.

OMP persists native goals as `mode_change` entries with `mode: "goal" | "goal_paused"` and `data: {goal: {objective, status, ...}}`. The extension replays `entry.data.goal` from the current branch on session start and resume, preserving active/paused status in its pane record; another mode ends the recorded goal. An owned OMP v18.18.8 session persisted the active-to-paused transition in this shape. The session JSONL owns this persistence; the pane JSON is the extension's derived state.

Desired monitor state is `<stateDir>/monitors/<encodeURIComponent(sessionId)>.json` with `{version:1,sessionId,monitors:[{name,argv,filter,cwd}]}`. `cataly boot` reads it without private transcript access and remains read-only.

An extension monitor is not a native `AsyncJobManager` job or daemon service. Native `wait` can return "Nothing to wait for" while a Cataly monitor remains alive; matching monitor events arrive through the existing extension message delivery. OMP 19's per-user daemon does not adopt these processes or older OMP daemons. Cataly reads its role/session receipts and OS process identity, not `omp ps --json`.

### Manager-tool boundary

`monitor` belongs to the Cataly main session: the selected role must be `cataly` and native `ctx.agent.kind` must be `main`. Registration is inactive by default. Session start, switch, branch and tree events remove an explicitly selected `monitor` from child tool lists, even when the child inherits the Cataly role or receives a copied role flag. The execution guard separately rejects child `start`, `stop` and `list` calls; hiding a tool is not authorization.

Ordinary tools such as `read`, `edit` and `bash`, including direct work in the main session, retain their existing selection and permission rules. This is an extension tool boundary, not an operating-system sandbox.

## Waiting on an identified operation

Both report paths can name the operation instead of treating a sentence as proof of a pending job:

```bash
cataly harness report build-lane --status waiting --for job:bg_7 --text "Waiting for the build"
cataly report build-lane --kind blocker --for approval:call_7 --text "Waiting for the native approval"
cataly report build-lane --kind blocker --for 'ci:owner/repo#42@12345' --text "Waiting for this check run"
```

`job:ID` binds the attested native session ID, session start and job start time; `approval:ID` binds a pending tool-call ID in that session. The extension copies the public pinned-host async-job snapshot and approval events into its existing process-bound record. The probe exposes only validated fields from the record that passes its existing writer, ancestry, process-start and session reread checks. A missing job manager is unknown, not an empty successful job list. Subagent approvals continue to hold input, but cannot stand in for a main-session approval.

These are **last observations**, not an atomic live snapshot or a new polling service. Lifecycle events and changed job snapshots at tool calls refresh the record; session switch and retirement discard its former observation. Report output names the complete identity, the latest observed state/time and the waiting interval. Repeating the same identity preserves its start; a reused job ID with a different start, another session or a changed CI head starts a different interval. An already observed finished job cannot be newly bound. Ordinary dependency prose remains an **unverified label**; old reports without structured metadata remain readable.

`ci:owner/repo#N` reads and binds the actual PR head SHA. Appending `@CHECK_RUN_ID` also reads that exact GitHub check run, requires the same head and a pending status, then rereads the PR head to refuse a move during observation. Head-only binding says nothing about whether checks are running. CI is queried only by the explicit report command, not by a new GitHub poll loop; a newer CI state needs another report.

Duty and skill freshness can emit one advisory `wait-ended` notice when a later native observation no longer contains the bound job or approval, or names a replacement session. Missing observations remain unknown, and an older observation cannot end a newer wait. An end is **not success, approval or permission to resume**: no native goal, pause, quota, blocker report, progress clock or completion gate is cleared. The root harness keeps its full waiting/nudge/40-minute escalation clock even if the target changes. The skill journal keeps the blocker until an explicit new report. Native/CI reads happen outside the registry lock. All skill report writers, including ordinary reports and supervision blockers, share that lane lock; the latest report, session generation and wait notice are rechecked in the same synchronous section as a waiting report append. Conditional budget reports recheck terminal state and duplicate blockers under that same lock, and warnings use the checked state. Activity-only observations cannot replace a blocked, halted or done report.

## Grouping

Each session carries the home's group label, the first 8 hex characters of the sha256 of the resolved `CATALY_HOME` path, so two homes never share one.

Only one duty loop runs per home: it takes `duty/lock` under `CATALY_HOME`, and a second `cataly harness duty` does not start while it is held.

## Targets

`cataly harness send`, `cataly harness role` and `cataly harness inbox` take a session in several forms:

- a headless ref or `tern:42`, with the runtime spelled out;
- `lead` or `duty`;
- a lane key.

A bare `42` is not a ref, because it is a legal lane key. Stored roles and inbox file names prefix the runtime (`tern:42`; inbox file `tern--42.jsonl`).

## Hooks and prompts

`$CATALY_HOME/config.json` can also hold `hooks`, argv templates that run without a shell:

```json
{
  "hooks": {
    "onReady": ["notify-send", "READY {key}", "{text} {evidence}"],
    "onReport": ["logger", "-t", "cataly", "{key}: {text}"],
    "onLost": ["logger", "-t", "cataly", "LOST {key}: {text}"],
    "reviewCommand": ["my-reviewer", "--pr", "{pr}", "--sha", "{sha}"]
  }
}
```

`onReady` runs on `cataly harness ready`, `onReport` on `cataly harness report`, and `onLost` when the duty loop finds a vanished session. `{key}`, `{text}` and `{evidence}` are replaced inside each argv element. Hooks run in the background; failure logs one stderr line without failing the command. `reviewCommand` replaces the built-in OMP reviewer in `cataly harness review`, receives `{pr}`, `{repo}`, `{number}`, `{sha}` and `{text}` (the rendered prompt), and must print `VERDICT: CLEAR` or `VERDICT: BLOCK`.

`CATALY_PROMPTS_DIR` overrides templates individually. A missing file uses the built-in template, so a directory need not provide every template, `nudge-waiting.md` included. An existing override is used as-is: an unreadable file or a directory at that path reports `lane-failed` before the nudge is queued or counted, and repairing it lets the next pass try again. A missing override's default nudge is a real nudge and counts once. An override `nudge-waiting.md` without `{{wholeTarget}}` still names the whole waiting target: when its `{{target}}` was cut to fit the first line, or it has no `{{target}}`, the whole target is added on its own line under the first line. Restart the long-lived duty process with the matching CLI source during cutover.

Duty queues notices before recording their nudge count, escalation marker or LOST status. Each lane has a persisted random `noticeId` for its incarnation and a `progressEpoch` counter advanced by counted new evidence and READY, independently of the wall clock. Retries reuse the same notice ID; new evidence, READY and a reused lane key get fresh identities even when timestamps or pane IDs repeat. LOST notices owed while no lead is registered or its inbox is locked remain in `duty/lead.jsonl`, outside the replaceable lane record, and move under the destination inbox lock once it is available.

Settled notice IDs remain in `<inbox>.ids` and move with forwarded or migrated queues. Deduplication covers retained local duty queues and these journals, including interrupted queue rewrites; distinct IDs remain distinct even when their timestamp and text match. It is not external exactly-once delivery: runtime acceptance and local settlement are separate operations. Losing the journal or selecting an unrelated destination is outside this boundary; ambiguous deliveries retain their existing held-message handling.

Every rewrite of an inbox queue holds the inbox's lock, and so does every append. A message sent while another process holds the lock (a flush, an ack, a migration or a duty notice) is written to a file of its own under `<inbox>.spool/`; the next holder of that lock moves it into the queue in order before it reads the queue and again after it rewrites it, and the duty loop lists a spooled inbox even when its queue is empty. A forwarded inbox's spool moves with its old entries to the new inbox. The send itself returns `QUEUED`. A spooled entry keeps its spool file's name, so a move cut short adds it once and an equal message sent in the same millisecond stays a second message, also when a migration carries both. When a spooled entry leaves its queue, its spool file's name is recorded with the delivered ids (`<inbox>.ids`), so a `.moving` file left by a move cut short after the entry was queued and delivered is removed on the next pass instead of being queued a second time.

Inbox and route locks record a unique random `nonce` alongside `pid`, `host` and `at`, so a delayed release cannot remove another acquisition even when its process and timestamp are unchanged. Stale classification does not depend on the nonce: a live local pid retains its lock; a dead local pid frees it; foreign-host or unreadable records use the existing age rule. A stale lock is reclaimed under an exclusive sibling `.inbox-claim-<sha256>` whose digest covers the target basename and complete observed lock content. Every claim component stays 77 bytes through recursive crash recovery. Directory aliases of the same physical parent and basename share that claim; the lexical directory path is not part of its digest. The claim holder still checks the stale snapshot before removal, and release still checks its full owner receipt.

A send holds the route lock of the inbox it names (`<inbox>.route`, stale under the inbox lock's rules) from reading any forward marker to writing its message or spool file. A send waits up to two seconds for a held route without blocking the process. A name is resolved again under the route before the message is written: a lane or role that switched sessions between the first resolution and the route gets the message at its new session, and a name that no longer resolves leaves the send where it first pointed. Duty notices (nudges, escalations, LOST notices and owed notices) resolve their lane or role again under the route the same way. Past a held route, a message addressed to the logical `lead` role (a report, READY, START, a loop summary or a held-delivery notice) is kept in a file of its own under `duty/lead.jsonl.spool/` and returns `QUEUED`, even if the role was replaced or disappeared after its initial resolution. That intent comes from the send target, not a later comparison with the current lead session. The next duty pass that finds the registered lead's route and inbox lock free moves it into that lead's inbox after the owed LOST notices, oldest first. An explicit session ref does not become a message for a future lead merely because it once held that role: past a held route it is refused (exit 2) with nothing queued. A duty notice is tried again on the next pass.

## Candidate command deadlines

The candidate updater applies each command's configured `timeoutMs` and sends `SIGKILL` only to its direct child on deadline or abort. After the direct child exits, or a deadline or abort occurs, the controller allows at most one additional second for stdout/stderr drainage. It then cancels its readers, synchronizes and closes its private log files, and retains the PID, known exit/signal, source binding, scope paths and error in the command receipt. Cancellation omits the unflushed redaction tail; incomplete output never establishes readiness or a successful report send.

Ref detection uses the same capture and drain bounds with a fixed 60-second command deadline. Each invocation retains separate private logs and a receipt; `detector/last-detection.json` identifies the latest receipt and PID. An incomplete capture raises `UpdateInterrupted`, including after exit zero, and never parses a head or records a source attempt. An already-aborted detector starts no child. Inspect the detector receipt and verify descendants have stopped before another attempt.

Configured literal secrets are redacted in full in stdout, stderr and command error receipts. A longer configured secret takes precedence over its shorter prefix regardless of configuration order, including across stream reads.

Environment and path isolation is not an OS sandbox. Descendants can survive a direct-child kill or output cancellation; the controller does not terminate process groups. A drain deadline holds the command as interrupted even when the direct child exited zero. A started reporter with incomplete output stays ambiguous and is never resent automatically. Inspect the retained receipt and verify every old child and descendant has stopped before `cataly upstream recover --config FILE --ack-stopped JOB_ID`; that maintainer command acknowledges the operator's verification rather than stopping a process tree.

## Remote Cataly sessions

Remote commands are opt-in operations on native OMP sessions with a Cataly `cataly` or `lane` role on this machine. They use no OMP account, published Collab link or new network listener. Commands do not discover ordinary OMP sessions or sessions from another installation.

Run `cataly remote policy wake on` to allow cold wake; it defaults off.

```sh
cataly remote sessions
cataly remote read SESSION --limit 20
cataly remote send SESSION --text 'Summarize your status' --id request-01 --no-wait
cataly remote receipt SESSION --id request-01
cataly remote watch SESSION --cursor 0 --until-completion
```

Use the exact session ID or a unique live prefix. `--generation` pins an observed activation; use it with a previously issued request ID or cursor. `send` uses OMP's admission API and preserves the message body. Headless delivery refuses slash-leading text because the pinned RPC mode may interpret it as a prompt template. A receipt confirms admission, not an assistant reply; `read` and `watch` show the session's actual output without guessing which concurrent input caused it. The optional `--steer` is explicit. Lost transport does not imply that a mutation failed. Inspect its receipt instead of resending blindly.

`interrupt` requests OMP turn cancellation and reports detached jobs separately; the pinned extension API cannot cancel independently owned background jobs. `model` changes the session's model and reads it back. `close` verifies disappearance before reporting closure. Headless sessions must settle even with `--force`: disconnect during work could cancel a native approval before the supervisor sees it. A lost close response holds cold wake until the operator checks the session. `attach` prints the transcript and then follows its event stream; it is read-only. A separately enabled OMP Collab room can still be joined with `omp join`.

`open` starts a managed OMP session with optional `--cwd`, `--name`, `--model`, `--thinking`, `--text` and `--worktree PATH [--branch BRANCH] [--base REF]`. The command cannot start a caller-supplied executable. It stores an opening receipt and does not duplicate a launch with the same request ID. `wake` accepts an exact stored ID from `open`, verifies it is unowned with OMP's session lease, and does not submit a prompt or resume a paused goal. Explicitly closed sessions and registered held lanes are not woken; use the lane's own `reopen` workflow for registered lanes.

`watch` streams bounded event pages; its cursor belongs to the live activation. A `gap` means old events have fallen out of the buffer. A report observed in a tool result is not a durable journal check, and turn output is not a lane Done assertion.

## Headless OMP lanes

On macOS and Linux, `cataly launch` starts a native OMP lane. Use the normal `cataly status`, `pause`, `resume` and `close` commands with the lane key; they address its recorded session.

Each headless lane runs one native `omp --mode rpc-ui` process owned by a local supervisor that survives CLI exits.

Before creating the first goal, the supervisor verifies the requested provider/model against the Cataly extension's catalog readback and OMP's current selection in that same session. If they disagree, no brief is sent. Inspect the registered lane with `cataly headless observe LANE`; the launcher does not substitute another model or retry the request.

`omp acp` can run multiple sessions but does not expose the pinned OMP goal lifecycle used by Cataly lane pause and resume. `rpc-ui` retains those operations and OMP's approval UI; it is not launched with `--no-ui` or an approval bypass. Use `cataly headless observe LANE` to view recent output and pending native dialogs. To answer a particular pending dialog locally, use `cataly headless answer LANE REQUEST_ID --answer-file FILE` (`-` reads stdin). The JSON must match the native dialog: `{"confirmed":false}`, `{"value":"Deny"}`, `{"cancelled":true}`, or `{"answers":[{"id":"question-id","selectedOptions":["choice"]}]}`. Submitting an answer does not assert that the native tool executed.

## Limits

- Remote commands act only on this machine's Cataly sessions; they are a separate operator entrypoint from the harness and inbox.
- Native remote and headless sockets require macOS or Linux. Do not enable remote control on an untrusted machine or share a control link as a substitute for granting a specific operation.
- Tern: no agent prompt call and no status words. Delivery types into the block, and its submit is confirmed only for OMP's classic input; see [Delivery](#delivery). CI has no Tern binary, so the adapter is tested against a recorder and checked by hand against a real Tern.

## Tests

These are test entrypoints, not a claim that they passed for any particular release. `bun test ./test/runtime-omp.test.ts ./test/runtime-omp-typed.test.ts` exercises process-bound identity, approvals and delivery. Skill `test/omp-session.test.ts`/`test/omp-pause.test.ts` cover OMP session/native goal contracts; extension `test/monitor-state.test.ts` asserts the desired monitor manifest. Fixture tests do not establish real OMP/provider or messenger behavior.

The tern adapter runs against its own recorder (`test/fake-tern.ts`) in `test/runtime-tern.test.ts`, `test/runtime-tern-deliver.test.ts` and `test/runtime-tern-screen.test.ts`; no real-Tern fixture test exists.

The Cataly extension appends compact guidance to root Cataly and lane prompts when that block is absent, without rewriting incoming blocks or changing permissions. It leaves plain and child sessions unchanged and keeps lane bookkeeping scoped to GPT-6.1 Sol. `extension/test/role-invariants.test.ts` exercises the native prompt hook before and after inserting a synthetic compaction entry into an in-memory session; it does not run live compaction or call a model.
