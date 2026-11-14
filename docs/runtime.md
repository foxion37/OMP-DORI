# Session runtimes: herdr and hc

**The OMP port retains herdr and hc (herdr-core) through the complete upstream runtime abstraction. Sessions on both can live in one home, and `dori harness migrate` moves sessions between them.** This document describes the source/runtime contract. The [first public preview](releases.md) supports Linux x64/herdr/Discord; macOS/hc CI coverage is distinct from live consumer support and exact-release QA evidence.

A session is one terminal with an agent or a loop in it: the lead, duty, the duty loop, the hourly loop, or a lane. herdr gives Dori workspaces, tabs and panes and detects the agent in a pane. hc gives Dori plain terminals with labels, and the agent in a terminal reports its own status. The harness talks to both through one interface, and nothing above that interface knows which runtime it is using.

The primary installed `dori` remains the skill CLI. Every root harness command here uses `dori harness ...`; `dori-harness ...` after root linking or `bun src/cli.ts ...` are equivalent entrypoints. For example, skill `dori send discord` posts to a messenger, while `dori harness send lead` sends to an agent session.

Lead and duty start OMP with role `dori`; lanes and the built-in reviewer use role `lane`. `DORI_AGENT_CMD` defaults to `omp`; explicit command/model/role arguments remain intact. The skill's own argv template and model precedence are separate; see [OMP session contracts](../README.md#omp-session-contract). The extension, pinned public omp-ulw and full sibling source layout must be installed together; the release installer provides that layout because the skill imports these runtime adapters by sibling path.

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

`--resume` starts the replacement on the old OMP session file (`omp --dori-role lane --resume=<path>` for a lane, role `dori` for lead/duty) instead of a handoff brief. It requires a live idle/done old agent and a recorded session path; otherwise nothing moves. Explicit custom agent commands retain their upstream `--session <path>` form. OMP role restoration does not imply its native goal resumed: inspect the goal and resume it deliberately when paused.

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

`onReady` runs on `dori harness ready`, `onReport` on `dori harness report`, and `onLost` when the duty loop finds a vanished session. `{key}`, `{text}` and `{evidence}` are replaced inside each argv element. Hooks run in the background; failure logs one stderr line without failing the command. `reviewCommand` replaces the built-in OMP reviewer in `dori harness review`, receives `{pr}`, `{repo}`, `{number}`, `{sha}` and `{text}` (the rendered prompt), and must print `VERDICT: CLEAR` or `VERDICT: BLOCK`. `DORI_PROMPTS_DIR` replaces the repo's `prompts/` directory.

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
