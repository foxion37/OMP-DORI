# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand.

## 1. Session runtime

Cataly runs on headless OMP by default on macOS and Linux: every lead, duty and lane session runs in native OMP under a local supervisor, without a terminal. Tern is the optional terminal runtime, and the only one on Windows, where the headless host has no Unix socket. Delivery holds when the agent’s live identity or approval state cannot be verified.

For a consumer installation, follow the [verified release guide](../../../docs/releases.md).

Current source and headless-capable releases prepare the [bound OMP 19.0.1](../../../docs/releases.md#current-source-bundle); neither stock OMP nor Cargo is required. Use the generated wrapper.

Tern (the optional terminal runtime; a source feature, outside the consumer preview): install Tern so `tern` is on PATH, and set `"sessionRuntime": "tern"` in the selected home’s config (or `CATALY_RUNTIME=tern` for the command), because the headless default is selected first. Installing `tern` alone does not change that default. Start the lead in a Tern block with `PI_TUI_NATIVE=0` (OMP’s classic UI; a natively drawn OMP shows `tern capture` no input) and set `leadPane` to its block id (`echo $TERN_PANE` there). Lanes open as tabs in the lead’s own Tern session, or in the session `laneWorkspace` names; set `workspaces` to that session so sweeps read no other one. See [Tern](../../../docs/runtime.md#tern).

## 2. Messenger

For Discord, use the shipped native Cataly bot commands. You need the owner’s own Discord application/bot token, not a user-account session. Node and agent-messenger are not prerequisites for this Discord text flow. Create and invite the bot through the [Discord Developer Portal](https://discord.com/developers/applications).

For other retained messenger integrations, [agent-messenger](https://github.com/agent-messenger/agent-messenger) remains optional platform-specific tooling with its own prerequisites and login procedures. Ask the owner which platform/identity to use before setting up those integrations.

- Telegram: stream a reply as it grows and show "Thinking…" with message drafts, send rich messages for tables and headings, and use topics in the private chat (turn on threaded mode in BotFather's mini app; there is no API for that switch).
- Discord: send or edit messages in channels/threads, create text-channel threads or tagged forum posts, rename/archive/reopen threads, and add or remove the bot's own reactions.

### If the owner picks Slack: user token or bot token

Ask which mode, give the trade-off as a short list, and wait for the choice:

- **User token**: the Cataly acts as a real member of the workspace.
  - It needs a paid seat, which the owner pays for.
  - It reads everything that member can see.
  - It can keep a green online dot (`cataly presence slack`).
- **Bot token**: the Cataly is a Slack app.
  - There's no seat cost.
  - It only sees channels it is invited to, within the scopes the app was granted.
  - It shows as an app, not a person.

Record the choice. With a user token, set `CATALY_SLACK_TOKEN` and `CATALY_SLACK_COOKIE` (the `d` cookie from that member's browser session). With a bot token, set `CATALY_SLACK_TOKEN` to the `xoxb-` token. If you run a second Cataly home on the same machine, also write that home's token to `slack-token` next to its `config.json` (`chmod 600`): `cataly launch` then hands its lanes the file's path, never the token (see `cataly launch` in `scripts.md`).

### Credential scope by process

| Process | Credential source |
|---|---|
| Lane agent | Native provider authentication remains available through the existing HOME/agent-directory and provider environment. `cataly launch` explicitly empties `CATALY_DISCORD_TOKEN` and `CATALY_TELEGRAM_TOKEN`, including stale values inherited from the launching environment. |
| Discord/Telegram monitor or send hook | Load the selected installation's protected token only inside the explicitly authorized messenger child. Direct sends from a lane require the same child-local loading; exporting tokens before `cataly launch` no longer supplies them. |
| Slack lane operations | Preserve the existing home-bound `slack-token` file path and owner/mode checks. The retained single-home environment-token flow is unchanged when no token file is configured. |
| Upstream model/reporter/check | Reuse the updater's capability allowlists: `modelEnv` only for models, `reporterEnv` only for reporters, and neither for checks. `modelAgentDir` retains the selected native authentication location. |

The general command runner still inherits its caller's environment; keep tokens out of the parent agent and load them at the messenger boundary. These rules reduce accidental propagation, not same-user file access: they are not an OS sandbox. Credential presence does not establish account identity, model availability, quota or permission to spend.

## 3. Bot

Use **Cataly** when creating a new bot or app unless the owner supplied a name. Keep any existing name or custom avatar. The bundled avatar is `assets/cataly-avatar.png`, with a JPEG version of the same image for automatic uploads.

`cataly inbound` for Discord or Telegram checks the verified bot profile at startup and fills in a missing avatar. Set `CATALY_MESSENGER_PROFILE_DEFAULTS=off` in the inbound process environment to keep a profile intentionally blank. An unavailable profile API does not stop message intake.

- **Telegram**: @BotFather requires a name and username to create a bot. Keep these when set; Cataly uses its default name only if Telegram reports an empty bot name. On an older Bot API that lacks profile photo updates, use @BotFather → `/setuserpic` and select the bundled image.
- **Discord**: Create and invite the owner's bot through the Developer Portal. Its required username stays as entered. Cataly sets only the bot's missing avatar, not the separate app icon in **General Information**.
  - Grant **View Channel** and **Read Message History** on the chosen channel. Replies need **Send Messages**; thread replies need **Send Messages in Threads**, and creating public threads additionally needs **Create Public Threads**. Grant **Add Reactions** for read receipts and **Manage Threads** where the bot needs to manage forum tags or rename/archive/reopen other threads. Forum post creation needs the forum's send permissions; channel overrides and moderated-tag permissions still apply. See [Discord permissions](https://docs.discord.com/developers/topics/permissions).
  - Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** for ordinary owner text. Discord applies content access across APIs, including REST; an online bot or successful API call is not proof that message content is available. Complete any approval Discord requires for the application. See [Message Content Intent](https://docs.discord.com/developers/events/gateway#message-content-intent).
  - Select this installation's `CATALY_HOME` first (`~/.cataly` for primary, `~/.omp-cataly` for the default consumer side home, or its custom path). Store the token alone in an owned regular `$CATALY_HOME/discord-token` file with mode `0600`, never another installation's token file. Keep its value out of chat, source, command arguments and monitor receipts. The native monitor recipes in the release guide load that file inside the child process, rather than exporting the token into the parent OMP session.
  - Set the non-secret `CATALY_DISCORD_GUILD_ID` in the operation command's child environment to resolve `send discord --to '#name'` or `thread discord create --to '#name'`. Exact channel IDs and `--thread ID` work without it. This variable enables operation name lookup only; owner intake retains its explicit channel/scope settings and `--gateway` opt-in.
  - Use one thread/post per task: `cataly thread discord create --to CHANNEL_ID --title "Task" --text "Starter"`, then `cataly send discord --thread THREAD_ID --text "Update"`. To open the thread on the owner's request itself, add `--message MESSAGE_ID`; to answer a message, `send discord --reply MESSAGE_ID`; for long or quoted bodies, `--text-file PATH` (`-` for standard input). Discord sends over 2000 characters are split. Forum posts can add repeated `--tag NAME`; `thread discord set THREAD_ID --tag NAME --archive` replaces tags and archives the post. See [the operation commands](scripts.md#cataly-thread-discord-create---to-channel---title-t---text-t---tag-name---message-id) for exact output and permission/error behavior.
  - Hooks receive a lane's thread as `platform:thread` (`discord:<thread id>`), while the Discord commands take the bare ID, so strip the prefix in the hook. With the protected token file, `hooks.threadReply` is `["bash", "-c", "set -eu; base=\"${CATALY_HOME:?Select this installation home}\"; CATALY_DISCORD_TOKEN=\"$(cat \"$base/discord-token\")\"; export CATALY_DISCORD_TOKEN; exec \"$base/bin/cataly\" send discord --thread \"${1#discord:}\" --text \"$2\"", "_", "{thread}", "{text}"]`, and `hooks.threadDone` is the same with `thread discord set \"${1#discord:}\" --archive` and only `"{thread}"` after `"_"`.
- **Slack**: Set the new app's name and bot display name to **Cataly**, unless the owner chooses another name. Upload the bundled image under **Basic Information → Display Information → App icon**. The inbox token does not manage the app's identity. With a user token, Cataly never changes the member's name or picture.

Greet the owner through the bot before doing anything else.

## 4. OMP extension and scripts

For current consumers, follow the [verified install procedure](../../../docs/releases.md#install-a-current-release). Use the selected home’s `bin/cataly`; the primary default is `~/.cataly` and the default macOS side home is `~/.omp-cataly`. Upgrades in an existing consumer home do not rewrite its configuration.

The [current release procedure](../../../docs/releases.md#install-a-current-release) also covers an isolated macOS arm64 home. The separate home has local wrappers and discovery rather than global links. Installation does not start watchers or services.

Maintainers installing an ordinary source checkout use the separate checkout installer from that repository root:

```sh
CATALY_INSTALL_MODE=side CATALY_NO_PULL=1 CATALY_SRC="$PWD" bash scripts/install-source.sh
```

This source-only command uses `OMP_CATALY_HOME` (default `~/.omp-cataly`) for config, state and wrappers, with only `omp-cataly` linked in `OMP_CATALY_BIN_DIR` (default `${BUN_INSTALL:-$HOME/.bun}/bin`). It leaves the primary Cataly's config, links and command alone. The selected side home and its paths must be separate from the primary home; consumer-managed homes and their aliases are protected in either mode.

Source installs use guarded source wrappers and frozen official native-addon reuse. Both modes set default lane commands to their own wrapper; absolute custom commands remain untouched.

For unmanaged source homes, `CATALY_INSTALL_MODE=primary` installs into `~/.cataly`; taking over another Cataly saves its config and link targets first, and a foreign default source checkout stops installation before changes. Without a mode, another unmanaged Cataly prompts in a terminal (default side) or stops without one; an existing side marker keeps side mode on reinstall. Consumer-managed `~/.cataly` always holds primary source installation, even with an omp-cataly extension link. Use its `cataly update check|install|status|rollback`, or keep a separate side source install.

For side operation of a source install, edit `<OMP_CATALY_HOME>/config.json`, keep its generated `stateDir` and `agentCommand`, and use `omp-cataly <command>` and `omp-cataly omp ...`. The wrappers source `env.sh`, set the side Cataly environment and put the side `bin/` first on `PATH`. Lanes stay apart from another Cataly's through the side home's own state directory. The OMP overlay hides `cataly-mode` and adds the renamed `omp-cataly-mode` skill. The wrapper uses `--no-extensions` and an explicit `-e` argument for this checkout's extension, with no global extension discovery or second import. Use a separate messenger bot/channel. Start the side lead with `omp-cataly harness up`; installation starts none of these processes.

The root `install.sh` remains the consumer release bootstrap. Run source installation only from an ordinary checkout outside frozen releases. See [source installation](../../../docs/releases.md#source-checkouts-for-maintainers) for fast-forward behavior, path overrides, and the complete side layout. These source instructions add no real OMP, provider or messenger QA claim.

Configure the selected home as follows:

Set `defaultCwd`, a provider-qualified `defaultModel` available to your account, and messenger hooks as needed. A model, from `defaultModel` or `--model`, may end in an OMP thinking level such as `provider/model:high`; the launch then also reads back the live level, which needs an extension host that implements `getThinkingLevel()`, as the bound OMP 18.20.0 does. An older host without it reads the level back as a mismatch and holds the brief with `STARTUP_MODEL_HOLD`, so use a plain `provider/model` there. Preserve the installer’s managed `agentCommand` and `sessionsDir`; see `references/scripts.md`. For Tern sessions only, configure `sessionRuntime` and the Tern `leadPane` and `laneWorkspace` as needed. Authenticate OMP using your account, export the non-secret `CATALY_DISCORD_OWNER_ID` and `CATALY_DISCORD_CHANNEL_ID` as positive decimal IDs, and keep the bot token in the private token file for child-only loading. Explicitly start the headless lead with `"$CATALY_HOME/bin/cataly" harness up`, after selecting `CATALY_HOME`.

The installed `cataly` provides messenger/lane commands and consumer `cataly update check|install|status|rollback`. Maintainer porting is `cataly upstream ... --config FILE`. The complete upstream harness is available through `cataly harness <args>` or `bun src/cli.ts`; linking the root package separately exposes `cataly-harness`.

## 5. Monitors

Monitor stdout and stderr each retain at most 64 KiB before a newline. Larger lines bypass the regex (never match a truncated fragment) and stream their exact raw bytes, including CR/LF when present, to a private `omp-cataly-monitor-*/output` file under the system temporary directory. A warning announces the path immediately; another records the byte count at newline or EOF. Read that file before acting on oversized input. UTF-8 chunk boundaries, normal filters and final unterminated lines keep their existing behavior. Delivery batches are bounded to 100 lines and 64 KiB including names and separators; a rendered message larger than the byte budget is saved in a file as well.

Spill directories are mode `0700` and files `0600`. They survive monitor stop/session switch and are not automatically deleted: inspect or remove them only when no longer needed, and account for system temporary-file cleanup. If a session ends before the batch containing a path notice is delivered, the retained files are still discoverable under the system temporary directory as `omp-cataly-monitor-*/output`; session isolation deliberately prevents forwarding that notice to another session. This bounds retained memory, not total disk usage. Storage or stream-read errors stop the child and report that output may be incomplete, including the partial file when available; restart remains an explicit decision. Session-bound notices never reach a different session.

Enable only the monitors the owner explicitly wants, using the OMP Cataly extension's native `monitor` tool in the owning session. The extension records start/stop intent and restores it when that session resumes; an explicitly stopped monitor stays stopped. Its boot metadata mirror contains monitor specifications, so `cataly boot` can recommend cleanup without reading private transcripts; it stops nothing itself. Installer, consumer update and rollback start none of these monitors.

The default `mode: "persistent"` retains that behavior. For a finite job, add `mode: "once"` to its start parameters: a successful exit (code 0, no signal or output failure) waits for output admission and confirmation of its stop record in the pinned host's default file-backed journal, so resume and `/new` do not repeat completed work. An admission failure keeps the unfinished intent; a journal persistence failure is reported because a future resume may repeat the work. Ended children awaiting admission retain their name for restore ownership but are not live health PIDs. Failed or interrupted once jobs retain restore intent, like persistent monitors; explicitly stop them if they must not be retried on resume. `op: "list"` includes running and recorded names, mode, status, and the last exit code/signal/time. `op: "stop"` also forgets an exited record; an explicit start can reuse its name. Completed records stay in their owning session, not in a new session's desired set.

For a long-lived receiver, opt into `mode: "daemon"`. Its `restart: { max: 5, backoffSec: 10 }` default permits five retries after the initial process, with exponential backoff capped at the platform timer limit. `max` accepts 0..100 and the base delay must be positive. A retry waits for the pinned host's default file-backed journal to confirm its exit record; storage or output failures stop automatic retries. Exhaustion is a durable stop and remains listed as `exhausted`, without being revived by resume or `/new`. An explicit start creates a fresh budget. An unfinished daemon keeps its recorded count on resume (which starts a process immediately); `/new` carries unfinished intent into a new generation with a fresh budget. Stop or session change cancels pending work. Lists distinguish `recording`, `backoff`, and a live child, and show retry counts and the next scheduled time without presenting an exited PID as live.

`silentAfterMin` opts any mode into one `MONITOR_SILENT` alert per quiet spell. Every stdout/stderr byte counts, including filtered lines, partial lines, and oversized output. New bytes rearm the alert; silence itself never kills or restarts a child. The threshold must be positive and fit the platform timer range. Operational retry/silence notices bound displayed names to 256 characters so they do not depend on spill storage; full names remain in listings, intent, and raw output.

Once intent uses mirror version 2; any daemon or silence policy requires version 3 so older managed updaters hold instead of silently dropping policy. Managed source replacement still waits for all once work to finish successfully or be explicitly stopped, including version 3 manifests. After new-policy intent is removed, the mirror returns to version 2 for remaining once work, or version 1 for ordinary persistent monitors. Existing intake, process identity and health requirements remain in force; a daemon waiting for persistence or backoff is not a healthy live child.

Set `CATALY_HOME` to the actual installation before starting its lead. The monitor and hook recipes read only `$CATALY_HOME/discord-token` and execute only `$CATALY_HOME/bin/cataly`. They never default to primary for a side or upgraded installation. Intake, presence and hooks remain separate opt-ins.

| Monitor | Command | Filter |
|---|---|---|
| Discord owner intake (opt-in) | `cataly inbound discord`, using the [protected-token child argv](../../../docs/releases.md#discord-owner-intake) | `^INBOUND` |
| done flow | `cataly watch` | `^LANE_` |
| dead panes (Tern) | `cataly dead-panes --loop 3` | `^(DEAD_PANE\|UNRECOGNISED_PANE\|WARN)` |
| host guard | `cataly guard --loop 1` | `^(HOST_GUARD\|WARN)` |
| freshness | `cataly freshness --loop 5` | `^(NUDGED\|WAIT-ENDED\|HELD\|DELIVERY-ERROR\|NUDGE-FAILED\|POSTED\|POST-FAILED\|NO-REPORT\|PENDING-REPORT\|STALE-REPORT\|UNRELAYED\|STALLED\|JOURNAL-ERROR\|WORKING-WHILE-PAUSED\|BLOCKED\|WARNING\|SUPERVISION-ERROR\|WARN)` |
| PR follow-up (opt-in, needs `gh` auth) | `cataly pr watch --loop 3` | `^(PR_(FEEDBACK\|CI_FAIL\|HEAD_MOVED\|MERGED\|CLOSED\|REOPENED\|WATCH_WARN)\|WARN)` |
| Slack inbound (Slack only) | `cataly inbound slack --loop 1` | `^INBOUND` |
| Telegram inbound (Telegram only) | `CATALY_TELEGRAM_TOKEN=… CATALY_TELEGRAM_OWNER_ID=… cataly inbound telegram --loop 1` | `^INBOUND` |
| presence (opt-in) | `cataly presence discord` (or retained Slack: `cataly presence slack`) | `^PRESENCE_` |

The recommended freshness filter covers all policies. `cataly doctor` requires `NUDGE-FAILED` only when `freshness.nudge` is `"idle-only"`, and `UNRELAYED` only when `freshness.postRaw` is `false` or `freshness.autoPostKinds` is set (including an empty list).

Freshness `HELD` marks an uncertain nudge or a nudge held by an earlier uncertain dispatch. `DELIVERY-ERROR` reports a local delivery-state fault; one lane's fault does not stop other lanes from being checked. Identical errors are reported once per lane registration until the error changes or a delivery check succeeds. Done flow reports `LANE_NOTIFY_HELD`, `LANE_NOTIFY_UNCONFIRMED` and `LANE_WATCH_ERROR` on stdout. Inspect the named lane with `cataly tell <key> --status` and the original session before deciding on `--resolve ID --note REASON`. Resolution sends nothing, and automated notices never replay a held message.

Intake runs only in the native Rust binary: `cataly inbound discord` replaces itself with it (same PID and `^INBOUND` stdout), and fails with build instructions when no binary is installed (`cargo build --locked --release`, then `CATALY_DISCORD_NATIVE_BIN=/abs/target/release/cataly`). `--wake-lanes` starts a lane's headless OMP session directly; the OMP extension still owns the live session.

The supported public receiver is **`cataly inbound discord`**. It requires the owner's bot token and the two configured IDs, polls every three seconds by default, and emits only that owner's messages from the exact channel. `--loop` is in minutes: `--loop 0.1` polls every six seconds and `--loop 0` runs once. First start saves a latest-message baseline without replay; wait for `INBOUND_READY discord owner=... channel=... bot=...`, then send a fresh owner message. Later records are `INBOUND discord <channel> <message> from=owner ref=<id|-> <JSON text>`, followed by `INBOUND_REPLY` for available reply context and ordered `INBOUND_ATTACHMENT` records for attachments, including voice metadata ([format](scripts.md#cataly-inbound-discord---loop-minutes---gateway----wake-lanes)). Attachment-only messages keep text `""`; metadata delivery starts no transcription. An owned per-channel cursor survives an explicit restart.

Use the [concrete native monitor argv recipe](../../../docs/releases.md#discord-owner-intake), which loads the protected token file only inside the child shell and inherits the two non-secret IDs from the owning OMP environment. No private helper, external CLI watcher, Node or agent-messenger is required. Startup checks bot authentication, Message Content Intent and View Channel/Read Message History access. Non-owner/bot/webhook/system messages do not become owner requests. Send permissions are required only for replies. See `scripts.md` for cursor/error details.

Discord REST inbound polling and message sending alone do not keep the bot online. While Cataly is used, an explicitly enabled `cataly presence discord` Gateway keeper must remain running under native monitor supervision, with `CATALY_DISCORD_TOKEN` supplied only in its child environment. Genuine Gateway READY/RESUMED produces `PRESENCE_READY`; only the first actual heartbeat acknowledgement per connection produces `PRESENCE_ACK`, while later acknowledgements update lifecycle state silently. Explicit monitor stop ends its sockets/retries and prints `PRESENCE_STOPPED discord`, so offline is the intended result. The inbound watcher is a separate opt-in process. Do not restore unrelated paused watchers or the maintainer updater to fix presence. See [presence operation and errors](../../../docs/releases.md#discord-online-presence).

## 6. First look around

Once the bot is live, explore the machine: running coding-agent sessions, the tools in use, recent logs. Write what you find into memory. `cataly sync` lists headless sessions that no lane registers; Cataly does not take over sessions it did not launch.
