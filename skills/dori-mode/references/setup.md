# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand.

## 1. herdr or hc

The Dori runs its sessions on one of two runtimes through the shared runtime abstraction. herdr gives every lane a tab, while hc (herdr-core) keeps each lane in a labelled terminal. This OMP port preserves both adapters, binds OMP session and approval records to the live agent process, and holds delivery when agent status or foreground identity is unknown.

For the first public preview, the live consumer support scope is Linux x64/herdr/Discord, with tested Bun 1.4.4 and native OMP 18.18.8. A manifest explicitly declaring macOS arm64/hc permits the isolated consumer layout; old manifests are Linux only, and this does not claim a macOS release or rollout. Other messengers have separately scoped coverage. Install from a [verified release](../../../docs/releases.md) and use your own provider/bot credentials. Installation starts none of the sessions or monitors below.

Current source `main` and newly built releases instead prepare the reviewed OMP 18.20.0 source bundle and b215 ULW overlay. They require no preinstalled stock OMP or Cargo. Start through the generated `omp` wrapper and read [the source-bundle contract](../../../docs/releases.md#current-source-bundle); the published `v0.1.2` support/installation facts remain historical, not overwritten assets or new QA claims.

herdr:

```sh
curl -fsSL https://herdr.dev/install.sh | sh
herdr integration install omp
herdr --skill                       # load its skill unless it is already in your context
```

hc:

```sh
curl -fsSL https://releases.herdr.dev/core/install.sh | sh
mkdir -p ~/.config/herdr-core && echo 'notes = false' >> ~/.config/herdr-core/config.toml
hc --skill                          # load its skill unless it is already in your context
```

`notes = false` stops hc from typing notes into a parent agent on its own, so the Dori's own sends are the only text that reaches a lane. With both installed, the Dori runs on hc unless `"runtime": "herdr"` is set in step 4; with only one on PATH, it uses that one.

## 2. Messenger

For the supported Discord preview, use the shipped native Dori bot commands. You need the owner's own Discord application/bot token, not a user-account session. Node and agent-messenger are not prerequisites for this Discord text flow. The bot is created and invited through the [Discord Developer Portal](https://discord.com/developers/applications); no external watch command or private helper is part of this installation.

For other retained messenger integrations, [agent-messenger](https://github.com/agent-messenger/agent-messenger) remains optional platform-specific tooling with its own prerequisites and login procedures. Ask the owner which platform/identity to use before setting up those integrations.

- Telegram: stream a reply as it grows and show "Thinking…" with message drafts, send rich messages for tables and headings, and use topics in the private chat (turn on threaded mode in BotFather's mini app; there is no API for that switch).
- Discord: send or edit messages in channels/threads, create text-channel threads or tagged forum posts, rename/archive/reopen threads, and add or remove the bot's own reactions.

### If the owner picks Slack: user token or bot token

Ask which mode, give the trade-off as a short list, and wait for the choice:

- **User token**: the Dori acts as a real member of the workspace.
  - It needs a paid seat, which the owner pays for.
  - It reads everything that member can see.
  - It can keep a green online dot (`dori presence slack`).
- **Bot token**: the Dori is a Slack app.
  - There's no seat cost.
  - It only sees channels it is invited to, within the scopes the app was granted.
  - It shows as an app, not a person.

Record the choice. With a user token, set `DORI_SLACK_TOKEN` and `DORI_SLACK_COOKIE` (the `d` cookie from that member's browser session). With a bot token, set `DORI_SLACK_TOKEN` to the `xoxb-` token. If you run a second Dori home on the same machine, also write that home's token to `slack-token` next to its `config.json` (`chmod 600`): `dori launch` then hands its lanes the file's path, never the token (see `dori launch` in `scripts.md`).

### Credential scope by process

| Process | Credential source |
|---|---|
| Lane agent | Native provider authentication remains available through the existing HOME/agent-directory and provider environment. `dori launch` explicitly empties `DORI_DISCORD_TOKEN` and `DORI_TELEGRAM_TOKEN`, including stale values inherited from a terminal server. |
| Discord/Telegram monitor or send hook | Load the selected installation's protected token only inside the explicitly authorized messenger child. Direct sends from a lane require the same child-local loading; exporting tokens before `dori launch` no longer supplies them. |
| Slack lane operations | Preserve the existing home-bound `slack-token` file path and owner/mode checks. The retained single-home environment-token flow is unchanged when no token file is configured. |
| Upstream model/reporter/check | Reuse the updater's capability allowlists: `modelEnv` only for models, `reporterEnv` only for reporters, and neither for checks. `modelAgentDir` retains the selected native authentication location. |

The general command runner still inherits its caller's environment; keep tokens out of the parent agent and load them at the messenger boundary. These rules reduce accidental propagation, not same-user file access: they are not an OS sandbox. Credential presence does not establish account identity, model availability, quota or permission to spend.

## 3. Bot

For Discord, create/invite the owner's own bot through the Developer Portal and finish the explicit bot setup below. Other retained messengers have their own browser/login flows. Then give the bot its avatar: the default is `assets/dori-avatar.png` in this skill, and the owner can swap in any image.

- **Telegram**: @BotFather → `/setuserpic` → pick the bot → send the image.
- **Discord**: Developer Portal → your application → **General Information** → App Icon, and **Bot** → Icon.
  - Grant **View Channel** and **Read Message History** on the chosen channel. Replies need **Send Messages**; thread replies need **Send Messages in Threads**, and creating public threads additionally needs **Create Public Threads**. Grant **Add Reactions** for read receipts and **Manage Threads** where the bot needs to manage forum tags or rename/archive/reopen other threads. Forum post creation needs the forum's send permissions; channel overrides and moderated-tag permissions still apply. See [Discord permissions](https://docs.discord.com/developers/topics/permissions).
  - Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** for ordinary owner text. Discord applies content access across APIs, including REST; an online bot or successful API call is not proof that message content is available. Complete any approval Discord requires for the application. See [Message Content Intent](https://docs.discord.com/developers/events/gateway#message-content-intent).
  - Select this installation's `DORI_HOME` first (`~/.dori` for primary, `~/.omp-dori` for the default consumer side home, or its custom path). Store the token alone in an owned regular `$DORI_HOME/discord-token` file with mode `0600`, never another installation's token file. Keep its value out of chat, source, command arguments and monitor receipts. The native monitor recipes in the release guide load that file inside the child process, rather than exporting the token into the parent OMP session.
  - Set the non-secret `DORI_DISCORD_GUILD_ID` in the operation command's child environment to resolve `send discord --to '#name'` or `thread discord create --to '#name'`. Exact channel IDs and `--thread ID` work without it. This variable enables operation name lookup only; owner intake retains its explicit channel/scope settings and `--gateway` opt-in.
  - Use one thread/post per task: `dori thread discord create --to CHANNEL_ID --title "Task" --text "Starter"`, then `dori send discord --thread THREAD_ID --text "Update"`. To open the thread on the owner's request itself, add `--message MESSAGE_ID`; to answer a message, `send discord --reply MESSAGE_ID`; for long or quoted bodies, `--text-file PATH` (`-` for standard input). Discord sends over 2000 characters are split. Forum posts can add repeated `--tag NAME`; `thread discord set THREAD_ID --tag NAME --archive` replaces tags and archives the post. See [the operation commands](scripts.md#dori-thread-discord-create---to-channel---title-t---text-t---tag-name---message-id) for exact output and permission/error behavior.
  - Hooks receive a lane's thread as `platform:thread` (`discord:<thread id>`), while the Discord commands take the bare ID, so strip the prefix in the hook. With the protected token file, `hooks.threadReply` is `["bash", "-c", "set -eu; base=\"${DORI_HOME:?Select this installation home}\"; DORI_DISCORD_TOKEN=\"$(cat \"$base/discord-token\")\"; export DORI_DISCORD_TOKEN; exec \"$base/bin/dori\" send discord --thread \"${1#discord:}\" --text \"$2\"", "_", "{thread}", "{text}"]`, and `hooks.threadDone` is the same with `thread discord set \"${1#discord:}\" --archive` and only `"{thread}"` after `"_"`.
- **Slack**:
  - bot token: the app's **Basic Information** → Display Information → App icon;
  - user token: the member's profile photo (`users.setPhoto`, or the profile page).

Greet the owner through the bot before doing anything else.

## 4. OMP extension and scripts

For the Linux preview, follow the [exact-tag install and checksum procedure](../../../docs/releases.md#install-the-exact-preview). The explicit CLI is `~/.dori/bin/dori`; add `~/.dori/bin` to your PATH. The consumer installer checks the required existing toolchain, installs the skill/role-gated extension and exact pinned public omp-ulw, and creates config only when absent. It preserves existing configuration, authentication and work/session data. Local `--from` assets can still require the first anonymous dependency fetch.

For a compatible macOS arm64/hc release, follow the [isolated consumer procedure](../../../docs/releases.md#isolated-macos-arm64hc-consumer): use local `~/.omp-dori/bin/omp-dori` and `~/.omp-dori/bin/dori`, with `--home "$HOME/.omp-dori"` on update commands. There are no global links or discovery. The operator checks and installs updates explicitly; no updater, publication policy, watcher, service, messenger or presence is automatically enabled. Each retained release keeps its exact pin through update and rollback. For migration, install first into a fresh separate home, preserve the source home, stop the source Dori, then copy or reconfigure selected config, state or auth only with the user's deliberate authorization before launching. Never overwrite a live source home or automatically copy secrets.

Maintainers installing an ordinary source checkout use the separate checkout installer from that repository root:

```sh
DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh
```

This source-only command uses `OMP_DORI_HOME` (default `~/.omp-dori`) for config, state and wrappers, with only `omp-dori` linked in `OMP_DORI_BIN_DIR` (default `${BUN_INSTALL:-$HOME/.bun}/bin`). It leaves the primary Dori's config, links and command alone. The selected side home and its paths must be separate from the primary home; consumer-managed homes and their aliases are protected in either mode.

Source omp-ulw defaults to the exact `omp-ulw.lock` base plus `omp-ulw.overlay.lock`/`omp-ulw.patch`, with guarded source wrappers and frozen official native-addon reuse. `OMP_ULW_REF=main` or an explicit branch/tag/commit selects a separate, unpatched custom checkout; `OMP_ULW_REPO` supplies its repository or a mirror for the locked base. `OMP_ULW_SRC`, a custom `ompUlwPath` or an existing standalone primary extension remain explicit external choices, not proof of the bundled default. Source config uses `ompUlwPath: ""` so the selected standalone dependency loads once. Both modes set default lane commands to their own wrapper; absolute custom commands remain untouched.

For unmanaged source homes, `DORI_INSTALL_MODE=primary` installs into `~/.dori`; taking over another Dori saves its config and link targets first, and a foreign default source checkout stops installation before changes. Without a mode, another unmanaged Dori prompts in a terminal (default side) or stops without one; an existing side marker keeps side mode on reinstall. Consumer-managed `~/.dori` always holds primary source installation, even with an omp-dori extension link. Use its `dori update check|install|status|rollback`, or keep a separate side source install.

For side operation of a source install, edit `<OMP_DORI_HOME>/config.json`, keep its generated `stateDir` and `agentCommand`, and use `omp-dori <command>`, `omp-dori omp ...` and `omp-dori hc ...`. The wrappers source `env.sh`, set the side Dori environment and `HC_SESSION` (default `omp-dori`, set through `OMP_DORI_HC_SESSION`), and put the side `bin/` first on `PATH`. hc keeps terminals without a `herdr.space` label out of the Herdr app, and a separate `HC_SESSION` is a separate core the app does not show: to watch the side Dori in the app, install with `OMP_DORI_HC_SESSION=default` (the core the app shows) and `OMP_DORI_HC_SPACE` set to a space id from `herdr-app ls`, and its lead and lanes open in that space (`DORI_HC_SPACE` in `env.sh`). Lanes stay apart from another Dori's through their `dori.group` label. The OMP overlay hides `dori-mode` and adds the renamed `omp-dori-mode` skill. The wrapper uses `--no-extensions` and explicit `-e` arguments for this checkout's extension and its selected omp-ulw, with no global extension discovery or second import. An external checkout choice is retained in the side home's `.omp-dori-ulw` symlink across reinstalls. Use a separate messenger bot/channel. To show the lead in the app, source the side home's `env.sh` first and run `omp-dori hc run --label "herdr.space=$DORI_HC_SPACE" --name omp-dori-lead -- omp-dori omp --dori-role dori`; installation starts none of these processes.

The root `install.sh` remains the consumer release bootstrap. Run source installation only from an ordinary checkout outside frozen releases. See [source installation](../../../docs/releases.md#source-checkouts-for-maintainers) for fast-forward behavior, path overrides, and the complete side layout. These source instructions add no real OMP, provider or messenger QA claim.

For the Linux consumer preview, configure its home as follows:

Edit `~/.dori/config.json`: for this preview choose `runtime: "herdr"`, `leadPane` (from `herdr pane current`), `laneWorkspace`, `defaultCwd`, a provider-qualified `defaultModel` available to your account and messenger hooks. Keep the installer's `agentCommand`, `sessionsDir` and `ompUlwPath`; `references/scripts.md` explains every field. Authenticate OMP yourself. Before starting `omp --dori-role dori` in herdr, set the non-secret `DORI_DISCORD_OWNER_ID` and `DORI_DISCORD_CHANNEL_ID` as positive decimal ID strings in that shell. The channel is the exact destination to read, including a thread only when its own ID is chosen. Keep `DORI_DISCORD_TOKEN` in the protected token file for child-only loading; no maintainer authentication is supplied.

The installed `dori` provides messenger/lane commands and consumer `dori update check|install|status|rollback`. Maintainer porting is `dori upstream ... --config FILE`. The complete upstream harness is available through `dori harness <args>` or `bun src/cli.ts`; linking the root package separately exposes `dori-harness`.

## 5. Monitors

Monitor stdout and stderr each retain at most 64 KiB before a newline. Larger lines bypass the regex (never match a truncated fragment) and stream their exact raw bytes, including CR/LF when present, to a private `omp-dori-monitor-*/output` file under the system temporary directory. A warning announces the path immediately; another records the byte count at newline or EOF. Read that file before acting on oversized input. UTF-8 chunk boundaries, normal filters and final unterminated lines keep their existing behavior. Delivery batches are bounded to 100 lines and 64 KiB including names and separators; a rendered message larger than the byte budget is saved in a file as well.

Spill directories are mode `0700` and files `0600`. They survive monitor stop/session switch and are not automatically deleted: inspect or remove them only when no longer needed, and account for system temporary-file cleanup. If a session ends before the batch containing a path notice is delivered, the retained files are still discoverable under the system temporary directory as `omp-dori-monitor-*/output`; session isolation deliberately prevents forwarding that notice to another session. This bounds retained memory, not total disk usage. Storage or stream-read errors stop the child and report that output may be incomplete, including the partial file when available; restart remains an explicit decision. Session-bound notices never reach a different session.

Enable only the monitors the owner explicitly wants, using the OMP Dori extension's native `monitor` tool in the owning session. The extension records start/stop intent and restores it when that session resumes; an explicitly stopped monitor stays stopped. Its boot metadata mirror contains monitor specifications, so `dori boot` can recommend cleanup without reading private transcripts; it stops nothing itself. Installer, consumer update and rollback start none of these monitors.

Select `DORI_HOME` explicitly before primary startup (`~/.dori`), or launch the consumer side lead through `"$HOME/.omp-dori/bin/omp-dori" hc run --name omp-dori-lead -- "$HOME/.omp-dori/bin/omp-dori" omp --dori-role dori` (substitute its real home when customized). That wrapper binds `DORI_HOME` and puts its own CLI first on `PATH`. The protected-token monitor and hook recipes require that selected home, read only `$DORI_HOME/discord-token`, and execute only `$DORI_HOME/bin/dori`; they never default to the primary installation for a side session. Intake, presence and hooks remain separate opt-ins.

| Monitor | Command | Filter |
|---|---|---|
| Discord owner intake (opt-in) | `dori inbound discord`, using the [protected-token child argv](../../../docs/releases.md#discord-owner-intake) | `^INBOUND` |
| done flow | `dori watch` | `^LANE_` |
| dead panes | `dori dead-panes --loop 3` | `^(DEAD_PANE\|UNRECOGNISED_PANE\|WARN)` |
| host guard | `dori guard --loop 1` | `^(HOST_GUARD\|WARN)` |
| freshness | `dori freshness --loop 5` | `^(NUDGED\|NUDGE-FAILED\|POSTED\|POST-FAILED\|NO-REPORT\|PENDING-REPORT\|STALE-REPORT\|UNRELAYED\|STALLED\|JOURNAL-ERROR\|WORKING-WHILE-PAUSED\|BLOCKED\|WARNING\|SUPERVISION-ERROR\|WARN)` |
| PR follow-up (opt-in, needs `gh` auth) | `dori pr watch --loop 3` | `^(PR_(FEEDBACK\|CI_FAIL\|HEAD_MOVED\|MERGED\|CLOSED\|REOPENED\|WATCH_WARN)\|WARN)` |
| Slack inbound (Slack only) | `dori inbound slack --loop 1` | `^INBOUND` |
| Telegram inbound (Telegram only) | `DORI_TELEGRAM_TOKEN=… DORI_TELEGRAM_OWNER_ID=… dori inbound telegram --loop 1` | `^INBOUND` |
| presence (opt-in) | `dori presence discord` (or retained Slack: `dori presence slack`) | `^PRESENCE_` |

The recommended freshness filter covers all policies. `dori doctor` requires `NUDGE-FAILED` only when `freshness.nudge` is `"idle-only"`, and `UNRELAYED` only when `freshness.postRaw` is `false` or `freshness.autoPostKinds` is set (including an empty list).

The supported public receiver is **`dori inbound discord`**. It requires the owner's bot token and the two configured IDs, polls every three seconds by default, and emits only that owner's messages from the exact channel. `--loop` is in minutes: `--loop 0.1` polls every six seconds and `--loop 0` runs once. First start saves a latest-message baseline without replay; wait for `INBOUND_READY discord owner=... channel=... bot=...`, then send a fresh owner message. Later records are `INBOUND discord <channel> <message> from=owner ref=<id|-> <JSON text>`, followed by `INBOUND_REPLY` for available reply context and ordered `INBOUND_ATTACHMENT` records for attachments, including voice metadata ([format](scripts.md#dori-inbound-discord---loop-minutes---gateway)). Attachment-only messages keep text `""`; metadata delivery starts no transcription. An owned per-channel cursor survives an explicit restart.

Use the [concrete native monitor argv recipe](../../../docs/releases.md#discord-owner-intake), which loads the protected token file only inside the child shell and inherits the two non-secret IDs from the owning OMP environment. No private helper, external CLI watcher, Node or agent-messenger is required. Startup checks bot authentication, Message Content Intent and View Channel/Read Message History access. Non-owner/bot/webhook/system messages do not become owner requests. Send permissions are required only for replies. See `scripts.md` for cursor/error details.

Discord REST inbound polling and message sending alone do not keep the bot online. While Dori is used, an explicitly enabled `dori presence discord` Gateway keeper must remain running under native monitor supervision, with `DORI_DISCORD_TOKEN` supplied only in its child environment. Genuine Gateway READY/RESUMED produces `PRESENCE_READY`; only the first actual heartbeat acknowledgement per connection produces `PRESENCE_ACK`, while later acknowledgements update lifecycle state silently. Explicit monitor stop ends its sockets/retries and prints `PRESENCE_STOPPED discord`, so offline is the intended result. The inbound watcher is a separate opt-in process. Do not restore unrelated paused watchers or the maintainer updater to fix presence. See [presence operation and errors](../../../docs/releases.md#discord-online-presence).

## 6. First look around

Once the bot is live, explore the machine: running coding-agent sessions, the tools in use, recent logs. Write what you find into memory, and adopt any running lanes with `dori adopt`.
