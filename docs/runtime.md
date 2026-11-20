# Session runtimes: herdr and hc

**The OMP port retains herdr and hc (herdr-core) through the complete upstream runtime abstraction. Sessions on both can live in one home, and `dori harness migrate` moves sessions between them.** This document describes the source/runtime contract. The [first public preview](releases.md) supports Linux x64/herdr/Discord; Linux hc CI and the cross-OS macOS/Windows CI are distinct from live consumer support and exact-release QA evidence. The hc jobs in the release-gating `ci.yml` run on Linux, while `.github/workflows/cross-os.yml` runs macOS and Windows jobs outside that gate.

A session is one terminal with an agent or a loop in it: the lead, duty, the duty loop, the hourly loop, or a lane. herdr gives Dori workspaces, tabs and panes and detects the agent in a pane. hc gives Dori plain terminals with labels, and the agent in a terminal reports its own status. The harness talks to both through one interface, and nothing above that interface knows which runtime it is using.

The primary installed `dori` remains the skill CLI. Every root harness command here uses `dori harness ...`; `dori-harness ...` after root linking or `bun src/cli.ts ...` are equivalent entrypoints. For example, skill `dori send discord` posts to a messenger, while `dori harness send lead` sends to an agent session.

Lead and duty start OMP with role `dori`; lanes and the built-in reviewer use role `lane`. Managed deployment and source-side wrappers pass a complete JSON string array through `DORI_AGENT_ARGV`. The harness quotes each argument for shell execution; the skill preserves the selected prefix and configured template suffix for installer-owned defaults, including their lexical and canonical installation paths. Managed commands retain their native config fence, pinned Dori extension and role-gated ULW selection. Explicit external commands remain intact. Without a managed selection, the harness retains `DORI_AGENT_CMD` as a user shell command, defaulting to `omp`. The skill configures its own argv template and default model separately; see the [skill configuration reference](../skills/dori-mode/references/scripts.md#configuration). The extension, pinned public omp-ulw and full sibling source layout must be installed together; the release installer provides that layout because the skill imports these runtime adapters by sibling path.

New terminal sessions receive the selected `HOME`, `DORI_CONFIG`, `DORI_HOME`, `DORI_STATE_DIR`, `DORI_AGENT_ARGV`, `DORI_OMP_ULW_PATH` and `OMP_ULW_SCOPE_FILE` explicitly across the terminal server boundary, along with configured `DORI_HERDR_SESSION` and `HC_SESSION`. Relative paths become absolute without collapsing symlinks or `..`; empty scope values remain unchanged. Fresh sessions clear `DORI_MANAGED_STARTUP` and obtain their own pane identity from the server. Initial launches, reviewer children, migration and native resume keep this context without forwarding arbitrary parent variables.

Required managed ULW imports may select a dependency directory or its `index.ts` entry. Import and factory failures in either form cancel role requests at both the session and provider boundaries. Ordinary sessions and explicitly configured external overlays retain their existing behavior.

Source installation holds when its selected native executable aliases a wrapper that the chosen install mode will overwrite. File identity checks cover direct paths, symlinks, aliased parents and hard links without reading wrapper contents. Explicit overrides are checked before their version probe or installation changes; a bundled native selection is checked as soon as it is available.

The native selection must also avoid traversing a command symlink that installation will replace: the primary `dori` link or side `omp-dori` link. This check follows relative links, parent aliases and directory prefixes without rewriting the selected pathname. Independent paths to the same executable remain valid because relinking leaves their target inode intact.

The primary wrapper captures Bun as an absolute pathname before generating its bound-ULW guard. A relative `PATH` entry therefore keeps selecting the installation-time Bun after the guard changes directory, including when the wrapper is launched from another directory.

Managed release preparation runs Git materialization and frozen dependency installation with a child-local `umask 077` before bundle admission. Root and skill packages use `--production`; the extension retains its full frozen install, including the OMP host dependency. The caller's mask stays unchanged, and independently group/world-writable bundle files remain rejected.

Source-native preparation builds the export viewer with the pinned upstream builder's `--check` mode after frozen dependency installation. The generated filename, size and SHA-256 must match the tracked viewer manifest without rewriting it. Native cache admission and launch require that exact owned asset; missing, modified, writable or additional assets hold admission.

Process attestation also recognizes the pinned launcher's optional `PI_TIMING=1` preload from the same source tree. The timing module must occupy its exact additional preload position; arbitrary, foreign, reordered or duplicate preloads remain untrusted. Session, ancestry, process-start and approval checks still apply.

## The interface

`SessionRuntime` in `src/runtime/types.ts` is the whole contract. Each runtime has one adapter, `src/runtime/herdr/` and `src/runtime/hc/`, and both run their CLI through one injectable process runner (`src/runtime/exec.ts`), so tests replace the binary with a recorder.

| Method | What it does |
|---|---|
| `self()` | The caller's own session, from `HERDR_PANE_ID` (+ `HERDR_WORKSPACE_ID`) or `HC_TERMINAL_ID` |
| `createGroup(label, cwd)` | herdr: a new workspace, returns its id. hc: returns the label, no call |
| `create(spec)` | A session with the user's shell in it and nothing started |
| `start(ref, command)` | Runs the command line in that shell |
| `list(filter)` | The live sessions, all of them or one group's |
| `probe(ref)` | One snapshot: status, agent name, foreground processes, title, cwd |
| `read(ref, lines)` | The last lines of the screen |
| `deliver(ref, text, opts)` | One message to the agent; never types into a shell |
| `submitTyped(ref, into)` | Presses only Enter for text an earlier delivery typed (herdr) |
| `typeIntoShell(ref, text)` | The operator's `--to-shell`, only into a session with no agent |
| `keys(ref, keys)` | Enter or Escape |
| `close(ref, scope)` | Closes the session, or its herdr tab |

A session is stored as a `SessionRef`: the runtime, the id (`w1:p3` on herdr, `t7` on hc), and the group and tab when the runtime has them. Every stored lane and role keeps its own ref, so commands on an existing session go to the runtime that opened it, whatever runtime is selected for new sessions. Lane records written before runtimes existed have no ref and read as herdr.

## Choosing a runtime

New sessions open on one runtime, picked in this order (`readRuntimeChoice` in `src/runtime/select.ts`):

1. `DORI_RUNTIME=herdr` or `DORI_RUNTIME=hc`.
2. `"runtime": "herdr"` or `"runtime": "hc"` in `$DORI_HOME/config.json` (default `~/.dori/config.json`) for the harness. The skill uses its `DORI_CONFIG` file (the same default); when those paths agree, one setting controls both.
3. `HC_TERMINAL_ID` is set: Dori runs inside an hc terminal, so hc.
4. `HERDR_PANE_ID` is set: Dori runs inside a herdr pane, so herdr.
5. The binaries on PATH: hc (herdr-core) when it is installed, else herdr. hc is the default runtime; with both installed, herdr is one config line away.

When neither binary is on PATH and nothing above decides, Dori refuses and prints the fix in one line:

```
neither herdr nor hc is on PATH: install hc (herdr-core) or herdr, or set "runtime": "herdr" or "hc" in <DORI_HOME>/config.json, or DORI_RUNTIME
```

(The real message prints the absolute path of your config file.)

An invalid `DORI_RUNTIME` or config value is an error. `dori harness status` prints the choice first, for example `RUNTIME hc (from config)`; sources are `env`, `config`, `detect:HC_TERMINAL_ID`, `detect:HERDR_PANE_ID` and `detect:path`. With no choice it prints `RUNTIME unset:` and a fix. Skill `dori boot` prints the same selection, or `RUNTIME unavailable:` and a failed check.

## How herdr verbs map to hc

The herdr adapter calls the left column, the hc adapter the right one. Every hc call carries `--json`.

| herdr | hc | Used for |
|---|---|---|
| `workspace create --label L --cwd D --no-focus` | `run --bg --no-parent --no-notify --cwd D --label dori.group=G ... -- env K=V $SHELL` | The lead on `dori harness up` (on hc, a group is only a label) |
| `tab create --label L --cwd D --no-focus [--workspace W]` | the same `run --bg ...` | Duty, lanes, migrated sessions |
| `pane split <near> --direction down --ratio 0.3` | the same `run --bg ...` | The duty loop and the hourly loop |
| `pane run <pane> <command>` | `send <t> -- <command>` | Starting the agent or loop in the new shell |
| `pane get <pane>` | `get <t>` | The status word and the agent name |
| `pane read <pane> --lines N --source recent` | `read <t> --lines N` | Screen reads (the migrate capture, launch checks) |
| `pane close <pane>`, or `tab close <tab>` | `kill <t>`, then `rm <t>` | Closing a session |
| `agent prompt <pane> <text>` | `send <t> [--if idle\|working] [--force] -- <text>` | Delivering a message |
| `pane send-text <pane> <text>` | not needed: `send` pastes and presses Enter in one step | herdr's fallback when `agent prompt` answers `agent_not_ready` |
| `pane send-keys <pane> enter` | `keys <t> enter` | Submitting typed text; Escape is `esc` on hc |
| `pane process-info --pane <pane>` | `get <t>` (its `foreground` and `pid` fields) | Whether a shell is in front |
| `--session <name>` (from `DORI_HERDR_SESSION`) | `HC_SESSION=<name>` in the environment | An isolated server, as the end-to-end tests use |

An injected skill environment controls `DORI_HERDR_SESSION` completely: if absent, herdr calls omit `--session` rather than inheriting the ambient value. With no injected environment, the skill continues to use `process.env`.

Listing is `pane list` on herdr and `ls [--label dori.group=G]` on hc. On hc, `rm` answers `live` while the program is still dying, so Dori retries it 5 times, 200 ms apart, and logs one line if the terminal is still running after that.

## Status

Dori reads a session's status before it types anything into it. The words are `idle`, `working`, `blocked`, `done`, `error`, `unknown`, `shell` (no agent, a bare shell) and `gone`.

On herdr, install the OMP integration with `herdr integration install omp`. The [herdr v0.9.5 integration](https://github.com/herdrdev/herdr/blob/v0.9.5/src/integration/assets/omp/herdr-agent-state.ts) reports OMP's session and agent state. The adapter retains upstream's narrow screen check for the empty omo input box when a runtime says `working` between turns with live monitors. A screen read that fails or does not match stays working; it is not a general OMP idle detector.

On hc, status comes from native OSC 7501. The retained OMP extension publishes `app=omp` for role sessions: idle on session start/agent end, working on agent start, blocked while approvals are open. Removing its owned role record invalidates the owned report as unknown. This is an actual HC report in addition to the process-bound JSON record; hc's unknown status remains held and conditional `--if` gates remain intact.

[OMP 18.14.2 `run-status.ts`](https://github.com/can1357/oh-my-pi/blob/v18.14.2/packages/coding-agent/src/utils/run-status.ts) also implements a general reporter for interactive TTY output when `terminal.programStatus` is enabled (the reporter starts enabled), including done/error and teardown clearing. Non-TTY or headless output does not use that built-in reporter. Custom agents need their own reporting integration. An agent that never reports stays unknown, or shell when an interactive shell is in front, and receives no queued input; an extension file alone never promotes native unknown to idle.

For a known idle/working native state, the attested OMP lifecycle record can refine the current idle/working state independently of native goal status. Native done stays done after identity and approval checks. The inherited screen check also reads the last 30 lines for a working agent with no shell in front, accepting only upstream's narrow idle-box pattern. If the raw hc word is working while the probe reads idle, the inbox retains `--if working`; a raw idle word uses `--if idle`. A status mismatch leaves the batch queued. The inherited working gate does not distinguish a new turn starting between probe and send from a working word that meant background activity.

Skill direct sends and migration checkpoint requests gate on the status they just read. A rejected send is failed; an ambiguous or working-turn delivery is unconfirmed and is not resent automatically. A migration checkpoint ask currently treats only a gone agent as a stop; a failed/unconfirmed ask is not surfaced separately. A done agent receives without an hc `--if` gate because hc accepts only idle or working there. Force can bypass native blocked/error status, but never a process-bound OMP approval hold. A shell in front always holds input on both runtimes.

Set `notes = false` in `~/.config/herdr-core/config.toml`. With notes on, hc types notes into a parent agent on its own, and Dori's inbox is meant to be the only thing that types into an agent. Dori already opens every terminal with `--no-parent --no-notify`.

### OMP identity, goal and approval records

The extension writes `<stateDir>/sessions/<encodeURIComponent(id)>.json`, preferring `HC_TERMINAL_ID` over `HERDR_PANE_ID`. Its schema is `paneId`, `role`, `sessionId`, optional `sessionFile`, `cwd`, `pid`, `startedAt`, `updatedAt`, `goal: {status, objective?}`, `approvalPending` and optional `agentStatus: idle|working` for compatibility with earlier records. `stateDir` follows `DORI_STATE_DIR`, then the `DORI_CONFIG` file's value, then `~/.dori/state`. Production callers pass that configured `stateDir` explicitly to enable OMP refinement. Runtime instances without it preserve native behavior and do not read operator config or extension state.

Both adapters attest the writer against the live terminal root, process ancestry, foreground and process start time before trusting a record. Missing, malformed, reused-pid, foreign or changing OMP identity stays unknown; an open approval becomes blocked even for force/submit-only delivery. Session IDs and files therefore come from the live OMP writer rather than an unrelated newest transcript. Linux process lookup and OMP's temp-relative, home-relative and absolute session-directory forms are preserved.

Native goals remain agent-owned. Skill pause/resume reads back active/paused state before committing its registry transition and reports exit 3 when unverified. Budget-limited and unknown native goal states map to blocked, never no goal. Resumed roles persist, but a resumed native goal can be paused and need `/goal resume`. The `dori` role's recorded monitor specs can restore on that session's resume; fresh installation and the container entrypoint do not start any messenger or watcher.

OMP persists native goals as `mode_change` entries with `mode: "goal" | "goal_paused"` and `data: {goal: {objective, status, ...}}`. The extension replays `entry.data.goal` from the current branch on session start and resume, preserving active/paused status in its pane record; another mode ends the recorded goal. An owned OMP v18.18.8 session persisted the active-to-paused transition in this shape. The session JSONL owns this persistence; the pane JSON is the extension's derived state.

Desired monitor state is `<stateDir>/monitors/<encodeURIComponent(sessionId)>.json` with `{version:1,sessionId,monitors:[{name,argv,filter,cwd}]}`. `dori boot` reads it without private transcript access and remains read-only.

### Manager-tool boundary

`monitor` belongs to the Dori main session: the selected role must be `dori` and native `ctx.agent.kind` must be `main`. Registration is inactive by default. Session start, switch, branch and tree events remove an explicitly selected `monitor` from child tool lists, even when the child inherits the Dori role or receives a copied role flag. The execution guard separately rejects child `start`, `stop` and `list` calls; hiding a tool is not authorization.

Native children still inherit their parent's role-gated ULW behavior. Ordinary tools such as `read`, `edit` and `bash`, including direct work in the main session, retain their existing selection and permission rules. This is an extension tool boundary, not an operating-system sandbox.

## Grouping

On herdr, `dori harness up` creates a workspace named `dori`: the lead is its root pane, duty a tab, and the two loops are splits below duty. A lane opened from a pane in that workspace becomes a tab there.

hc has no workspaces, tabs or layout. Dori opens one terminal per session and labels it:

- `dori.group`: the home's group, the first 8 hex characters of the sha256 of the resolved `DORI_HOME` path, so two homes never share one;
- `dori.role`: `lead`, `duty`, `duty-loop`, `hourly-loop` or `lane`;
- `dori.name`: the session's name;
- `dori.lane`: the lane key, on lanes only.

`hc ls --label dori.group=<g>` lists one home's sessions. The terminal also gets the session name as its hc name when no live terminal holds it, but Dori identifies a terminal by its address and labels, never by the name.

Only one duty loop runs per home, whatever the runtime: it takes `duty/lock` under `DORI_HOME`, and a second `dori harness duty` does not start while it is held.

## Targets

`dori harness send`, `dori harness role` and `dori harness inbox` take a session in several forms:

- `herdr:w1:p3` or `hc:t7`, with the runtime spelled out;
- a bare `w1:p3`, which is a herdr pane;
- `lead` or `duty`;
- a lane key.

A bare `t7` is not a ref, because `t7` is a legal lane key: a lane named `t7` is that lane. Stored roles and inbox file names keep herdr refs bare and prefix every other runtime (`hc:t7`), so files written before runtimes existed still match.

## Migrating sessions

```text
dori harness migrate [--to hc|herdr] (--lane K | --role lead|duty|duty-loop|hourly-loop | --all) [--dry-run] [--wait-minutes N] [--resume]
```

`--to` defaults to the selected runtime. `--all` takes every open lane, then lead and duty, then the duty loop and the hourly loop. For each agent session the steps are:

1. Hold. A journal is created at `DORI_HOME/migrate/<name>.json` and the lane is marked as migrating, so the duty loop neither nudges it nor flushes its inbox.
2. Checkpoint. The agent is asked to write a handoff checkpoint (goal, open todos, last state) to `briefs/<name>.handoff.md` and stop. Dori waits until it stops working, up to `--wait-minutes` (default 10). A `blocked` agent is asked nothing.
3. Capture. A handoff brief `briefs/<name>.migrate-<time>.md` is written: the original brief, a `## Handoff` section with the last 20 lane log entries, the checkpoint, the last 80 screen lines and the queued messages, then the lane rules.
4. Open. The replacement opens on the target, in this home's group on hc or a new `dori` workspace on herdr, with the agent started on the handoff brief.
5. Verify. The replacement must report `idle` or `working` within 3 minutes.
6. Move the inbox. A forward marker on the old inbox names the new session, and the old entries are merged into the new inbox. Queued entries stay queued, held entries stay held, and an entry that was typed but never submitted becomes held.
7. Switch. The lane or role record points at the new session, and the lane keeps the old ref in `migratedFrom`.
8. Close. The old session is closed, messages that late senders appended to the old inbox are moved over, the marker is removed, and the journal is deleted.

Each session ends with one line:

- `MIGRATED <name> <old> -> <new>`: done.
- `MIGRATE_ROLLBACK <name> <new> <why>`: verify failed. The replacement is closed, the inbox goes back unchanged with held entries still held, the hold is lifted, and the exit code is 3.
- `DEFERRED <name> blocked` or `DEFERRED <name> working past N min`: nothing moved, and the hold is lifted.
- `SKIP <name> already on <runtime>`.

`--dry-run` prints `PLAN <name> <old> -> <runtime>` with the queued-message count and changes nothing. An interrupted run resumes at its journal phase when started again; a second `dori harness migrate` of the same session cannot start concurrently.

`--resume` starts the replacement on the old OMP session file (`omp --dori-role lane --resume=<path>` for a lane, role `dori` for lead/duty) instead of a handoff brief. It requires a live idle/done old agent and a recorded session path; otherwise nothing moves. Explicit custom agent commands retain their upstream `--session <path>` form. OMP role restoration does not imply its native goal resumed: inspect the goal and preserve paused ownership until the user explicitly directs resumption. A migration or monitor recovery event is not that instruction.

The two loops are plain processes with no inbox and no agent, so they skip steps 2, 3, 5 and 6. The duty loop's old session closes before the new one opens, since the lock allows one per home. The hourly loop's new session opens first, and its own lock keeps the two from running the same hour.

## Hooks and prompts

`$DORI_HOME/config.json` can also hold `hooks`, argv templates that run without a shell:

```json
{
  "runtime": "hc",
  "hooks": {
    "onReady": ["notify-send", "READY {key}", "{text} {evidence}"],
    "onReport": ["logger", "-t", "dori", "{key}: {text}"],
    "onLost": ["logger", "-t", "dori", "LOST {key}: {text}"],
    "reviewCommand": ["my-reviewer", "--pr", "{pr}", "--sha", "{sha}"]
  }
}
```

`onReady` runs on `dori harness ready`, `onReport` on `dori harness report`, and `onLost` when the duty loop finds a vanished session. `{key}`, `{text}` and `{evidence}` are replaced inside each argv element. Hooks run in the background; failure logs one stderr line without failing the command. `reviewCommand` replaces the built-in OMP reviewer in `dori harness review`, receives `{pr}`, `{repo}`, `{number}`, `{sha}` and `{text}` (the rendered prompt), and must print `VERDICT: CLEAR` or `VERDICT: BLOCK`.

`DORI_PROMPTS_DIR` overrides templates individually. A missing file uses the built-in template, so a directory from before waiting-lane supervision can omit `nudge-waiting.md`. An existing override is used as-is: an unreadable file or a directory at that path reports `lane-failed` before the nudge is queued or counted, and repairing it lets the next pass try again. A missing override's default nudge is a real nudge and counts once. An override `nudge-waiting.md` without `{{wholeTarget}}` still names the whole waiting target: when its `{{target}}` was cut to fit the first line, or it has no `{{target}}`, the whole target is added on its own line under the first line. Restart the long-lived duty process with the matching CLI source during cutover.

Duty queues notices before recording their nudge count, escalation marker or LOST status. Each lane has a persisted random `noticeId` for its incarnation and a `progressEpoch` counter advanced by counted new evidence and READY, independently of the wall clock. Retries reuse the same notice ID; new evidence, READY and a reused lane key get fresh identities even when timestamps or pane IDs repeat. Legacy records persist their initial identity before their first notice is queued. LOST notices owed while no lead is registered or its inbox is locked remain in `duty/lead.jsonl`, outside the replaceable lane record, and move under the destination inbox lock once it is available.

Settled notice IDs remain in `<inbox>.ids` and move with forwarded or migrated queues. Deduplication covers retained local duty queues and these journals, including interrupted queue rewrites; distinct IDs remain distinct even when their timestamp and text match. It is not external exactly-once delivery: runtime acceptance and local settlement are separate operations. Losing the journal or selecting an unrelated destination is outside this boundary; ambiguous deliveries retain their existing held-message handling.

Every rewrite of an inbox queue holds the inbox's lock, and so does every append. A message sent while another process holds the lock (a flush, an ack, a migration or a duty notice) is written to a file of its own under `<inbox>.spool/`; the next holder of that lock moves it into the queue in order before it reads the queue and again after it rewrites it, and the duty loop lists a spooled inbox even when its queue is empty. A forwarded inbox's spool moves with its old entries to the new inbox. The send itself returns `QUEUED`. A spooled entry keeps its spool file's name, so a move cut short adds it once and an equal message sent in the same millisecond stays a second message, also when a migration carries both. When a spooled entry leaves its queue, its spool file's name is recorded with the delivered ids (`<inbox>.ids`), so a `.moving` file left by a move cut short after the entry was queued and delivered is removed on the next pass instead of being queued a second time.

Inbox and route locks record a unique random `nonce` alongside `pid`, `host` and `at`, so a delayed release cannot remove another acquisition even when its process and timestamp are unchanged. Legacy records without a nonce keep the same stale classification: a live local pid retains its lock; a dead local pid frees it; foreign-host or unreadable records use the existing age rule. A stale lock is reclaimed under an exclusive sibling `.inbox-claim-<sha256>` whose digest covers the target basename and complete observed lock content. Every claim component stays 77 bytes through recursive crash recovery. Directory aliases of the same physical parent and basename share that claim; the lexical directory path is not part of its digest. The claim holder still checks the stale snapshot before removal, and release still checks its full owner receipt.

A send holds the route lock of the inbox it names (`<inbox>.route`, stale under the inbox lock's rules) from reading the forward marker to writing its message or spool file. A migration holds the old inbox's route while it writes the marker, drains the old inbox and removes the marker (steps 6 and 8) and while it rolls back, so a message is never written to an inbox the migration has already drained. A rollback also holds the replacement's route: a send addressed to the replacement directly has written before the rollback moves the replacement's spool and queue back to the old inbox, and none writes there until that move is done. A send waits up to two seconds for a held route without blocking the process. A name is resolved again under the route before the message is written: a lane or role that switched sessions between the first resolution and the route gets the message at its new session, and a name that no longer resolves leaves the send where it first pointed. Duty notices (nudges, escalations, LOST notices and owed notices) resolve their lane or role again under the route the same way. Past a held route, a message addressed to the logical `lead` role (a report, READY, START, a loop summary or a held-delivery notice) is kept in a file of its own under `duty/lead.jsonl.spool/` and returns `QUEUED`, even if the role was replaced or disappeared after its initial resolution. That intent comes from the send target, not a later comparison with the current lead session. The next duty pass that finds the registered lead's route and inbox lock free moves it into that lead's inbox after the owed LOST notices, oldest first. An explicit session ref or pane id does not become a message for a future lead merely because it once held that role: past a held route it is refused (exit 2) with nothing queued. A duty notice is tried again on the next pass.

The forward marker is the only redirect, and it lives only while a migration runs: the final drain (step 8) and a rollback remove it, and neither leaves anything behind on either id. herdr pane ids and hc terminal ids are used again for new sessions, so after a migration a session ref, a bare pane id or `--to-shell` naming the old id reaches whatever session holds that id now, never the replacement. To reach a migrated session, send to its lane key or role.

## Candidate command deadlines

The candidate updater applies each command's configured `timeoutMs` and sends `SIGKILL` only to its direct child on deadline or abort. After the direct child exits, or a deadline or abort occurs, the controller allows at most one additional second for stdout/stderr drainage. It then cancels its readers, synchronizes and closes its private log files, and retains the PID, known exit/signal, source binding, scope paths and error in the command receipt. Cancellation omits the unflushed redaction tail; incomplete output never establishes readiness or a successful report send.

Ref detection uses the same capture and drain bounds with a fixed 60-second command deadline. Each invocation retains separate private logs and a receipt; `detector/last-detection.json` identifies the latest receipt and PID. An incomplete capture raises `UpdateInterrupted`, including after exit zero, and never parses a head or records a source attempt. An already-aborted detector starts no child. Inspect the detector receipt and verify descendants have stopped before another attempt.

Configured literal secrets are redacted in full in stdout, stderr and command error receipts. A longer configured secret takes precedence over its shorter prefix regardless of configuration order, including across stream reads.

Environment and path isolation is not an OS sandbox. Descendants can survive a direct-child kill or output cancellation; the controller does not terminate process groups. A drain deadline holds the command as interrupted even when the direct child exited zero. A started reporter with incomplete output stays ambiguous and is never resent automatically. Inspect the retained receipt and verify every old child and descendant has stopped before `dori upstream recover --config FILE --ack-stopped JOB_ID`; that maintainer command acknowledges the operator's verification rather than stopping a process tree.

## Limits

- No remote sessions. hc can run terminals on other machines (`--on`), and Dori does not use it: every session is on the local core, and `dori` ignores terminals mirrored from other machines.
- No window layout on hc. The lead, duty and the loops are separate terminals; open them with `hc attach <t>`.
- hc on Windows is untested here.

## Tests

These are test entrypoints, not a claim that they passed for any particular release. `bun test ./test/runtime-omp.test.ts ./test/runtime-omp-typed.test.ts` exercises process-bound identity, approvals and typed delivery on fake herdr/hc. Skill `test/omp-session.test.ts`/`test/omp-pause.test.ts` cover OMP session/native goal contracts; extension `test/status.test.ts` asserts HC status frames and role-removal invalidation, and `test/monitor-state.test.ts` asserts the desired monitor manifest. Full `bun test ./test/` includes both adapters against recorders. Real-server fixture tests are `test/e2e.test.ts` (isolated `herdr --session`), `test/e2e-hc.test.ts` (isolated `HC_SESSION`/XDG and an OSC fixture), and `test/e2e-migrate.test.ts` (herdr to hc); each skips without its binary. Fixture tests do not establish real OMP/provider or messenger behavior.

The Dori extension appends compact guidance to root Dori and lane prompts when that block is absent, without rewriting incoming blocks or changing permissions. It leaves plain and child sessions unchanged and keeps lane bookkeeping scoped to GPT-6.1 Sol. `extension/test/role-invariants.test.ts` exercises the native prompt hook before and after inserting a synthetic compaction entry into an in-memory session; it does not run live compaction or call a model.
