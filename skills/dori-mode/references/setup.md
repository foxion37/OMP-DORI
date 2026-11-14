# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand.

## 1. herdr or hc

The Dori runs its sessions on one of two runtimes through the shared runtime abstraction. herdr gives every lane a tab, while hc (herdr-core) keeps each lane in a labelled terminal. This OMP port preserves both adapters, binds OMP session and approval records to the live agent process, and holds delivery when agent status or foreground identity is unknown.

For the first public preview, the live consumer support scope is Linux x64/herdr/Discord, with tested Bun 1.4.4 and native OMP 18.18.8. hc and the other messengers remain advanced source features with separately scoped coverage. Install from the [verified exact release](../../../docs/releases.md) and use your own provider/bot credentials. Installation starts none of the sessions or monitors below.

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

## 3. Bot

For Discord, create/invite the owner's own bot through the Developer Portal and finish the explicit bot setup below. Other retained messengers have their own browser/login flows. Then give the bot its avatar: the default is `assets/dori-avatar.png` in this skill, and the owner can swap in any image.

- **Telegram**: @BotFather → `/setuserpic` → pick the bot → send the image.
- **Discord**: Developer Portal → your application → **General Information** → App Icon, and **Bot** → Icon.
  - Grant **View Channel** and **Read Message History** on the chosen channel. Replies need **Send Messages**; thread replies need **Send Messages in Threads**, and creating public threads additionally needs **Create Public Threads**. Grant **Add Reactions** for read receipts and **Manage Threads** where the bot needs to manage forum tags or rename/archive/reopen other threads. Forum post creation needs the forum's send permissions; channel overrides and moderated-tag permissions still apply. See [Discord permissions](https://docs.discord.com/developers/topics/permissions).
  - Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** for ordinary owner text. Discord applies content access across APIs, including REST; an online bot or successful API call is not proof that message content is available. Complete any approval Discord requires for the application. See [Message Content Intent](https://docs.discord.com/developers/events/gateway#message-content-intent).
  - Store the token alone in an owned regular `~/.dori/discord-token` file with mode `0600`. Keep its value out of chat, source, command arguments and monitor receipts. The native monitor recipes in the release guide load that file inside the child process, rather than exporting the token into the parent OMP session.
  - Set the non-secret `DORI_DISCORD_GUILD_ID` in the operation command's child environment to resolve `send discord --to '#name'` or `thread discord create --to '#name'`. Exact channel IDs and `--thread ID` work without it. This variable enables operation name lookup only; owner intake retains its explicit channel/scope settings and `--gateway` opt-in.
  - Use one thread/post per task: `dori thread discord create --to CHANNEL_ID --title "Task" --text "Starter"`, then `dori send discord --thread THREAD_ID --text "Update"`. Forum posts can add repeated `--tag NAME`; `thread discord set THREAD_ID --tag NAME --archive` replaces tags and archives the post. See [the operation commands](scripts.md#dori-thread-discord-create---to-channel---title-t---text-t---tag-name) for exact output and permission/error behavior.
- **Slack**:
  - bot token: the app's **Basic Information** → Display Information → App icon;
  - user token: the member's profile photo (`users.setPhoto`, or the profile page).

Greet the owner through the bot before doing anything else.

## 4. OMP extension and scripts

For public releases, follow the [exact-tag install and checksum procedure](../../../docs/releases.md#install-the-exact-preview). The explicit CLI is `~/.dori/bin/dori`; add `~/.dori/bin` to your PATH. The consumer installer checks the required existing toolchain, installs the skill/role-gated extension and exact pinned public omp-ulw, and creates config only when absent. It preserves existing configuration, authentication and work/session data. Local `--from` assets can still require the first anonymous dependency fetch.

Maintainers installing an ordinary source checkout use the separate checkout installer from that repository root:

```sh
DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh
```

This source-only command uses `OMP_DORI_HOME` (default `~/.omp-dori`) for config, state and wrappers, with only `omp-dori` linked in `OMP_DORI_BIN_DIR` (default `${BUN_INSTALL:-$HOME/.bun}/bin`). It leaves the primary Dori's config, links and command alone. The selected side home and its paths must be separate from the primary home; consumer-managed homes and their aliases are protected in either mode.

Source omp-ulw follows `OMP_ULW_REF` (default latest `main`, with an implicit `lock` fallback on OMP below 18.19.0); `lock` selects `omp-ulw.lock`, and explicit branches/tags/commits are honored. `OMP_ULW_REPO` selects a fork/mirror. `OMP_ULW_SRC` or a configured custom `ompUlwPath` reuses an existing checkout. Source config then uses `ompUlwPath: ""` so OMP loads the selected extension once. Primary mode reuses a standalone checkout identified by `index.ts` and `presets.ts`, or links its own globally; a later standalone removes only its earlier owned default link. Primary source omp-ulw therefore serves plain OMP sessions too. Consumer installs and the retained container keep their verified lock pins and nonempty import behavior.

For unmanaged source homes, `DORI_INSTALL_MODE=primary` installs into `~/.dori`; taking over another Dori saves its config and link targets first, and a foreign default source checkout stops installation before changes. Without a mode, another unmanaged Dori prompts in a terminal (default side) or stops without one; an existing side marker keeps side mode on reinstall. Consumer-managed `~/.dori` always holds primary source installation, even with an omp-dori extension link. Use its `dori update check|install|status|rollback`, or keep a separate side source install.

For side operation, edit `<OMP_DORI_HOME>/config.json`, keep its generated `stateDir` and `agentCommand`, and use `omp-dori <command>`, `omp-dori omp ...` and `omp-dori hc ...`. The wrappers source `env.sh`, set the side Dori environment and `HC_SESSION` (default `omp-dori`, set through `OMP_DORI_HC_SESSION`), and put the side `bin/` first on `PATH`. The OMP overlay hides `dori-mode` and adds the renamed `omp-dori-mode` skill. The wrapper uses `--no-extensions` and explicit `-e` arguments for this checkout's extension and its selected omp-ulw, with no global extension discovery or second import. An external checkout choice is retained in the side home's `.omp-dori-ulw` symlink across reinstalls. Use a separate messenger bot/channel. The hc lead command is `omp-dori hc run --name omp-dori-lead -- omp-dori omp --dori-role dori`; installation starts none of these processes.

The root `install.sh` remains the consumer release bootstrap. Run source installation only from an ordinary checkout outside frozen releases. See [source installation](../../../docs/releases.md#source-checkouts-for-maintainers) for fast-forward behavior and path overrides, and the [README](../../../README.md#source-installation-next-to-an-existing-dori) for the complete side layout. These source instructions add no real OMP, provider or messenger QA claim.

For the verified consumer preview, configure its home as follows:

Edit `~/.dori/config.json`: for this preview choose `runtime: "herdr"`, `leadPane` (from `herdr pane current`), `laneWorkspace`, `defaultCwd`, a provider-qualified `defaultModel` available to your account and messenger hooks. Keep the installer's `agentCommand`, `sessionsDir` and `ompUlwPath`; `references/scripts.md` explains every field. Authenticate OMP yourself. Before starting `omp --dori-role dori` in herdr, set the non-secret `DORI_DISCORD_OWNER_ID` and `DORI_DISCORD_CHANNEL_ID` as positive decimal ID strings in that shell. The channel is the exact destination to read, including a thread only when its own ID is chosen. Keep `DORI_DISCORD_TOKEN` in the protected token file for child-only loading; no maintainer authentication is supplied.

The installed `dori` provides messenger/lane commands and consumer `dori update check|install|status|rollback`. Maintainer porting is `dori upstream ... --config FILE`. The complete upstream harness is available through `dori harness <args>` or `bun src/cli.ts`; linking the root package separately exposes `dori-harness`.

## 5. Monitors

Enable only the monitors the owner explicitly wants, using the OMP Dori extension's native `monitor` tool in the owning session. The extension records start/stop intent and restores it when that session resumes; an explicitly stopped monitor stays stopped. Its boot metadata mirror contains monitor specifications, so `dori boot` can recommend cleanup without reading private transcripts; it stops nothing itself. Installer, consumer update and rollback start none of these monitors.

| Monitor | Command | Filter |
|---|---|---|
| Discord owner intake (opt-in) | `dori inbound discord`, using the [protected-token child argv](../../../docs/releases.md#discord-owner-intake) | `^INBOUND` |
| done flow | `dori watch` | `^LANE_` |
| dead panes | `dori dead-panes --loop 3` | `^(DEAD_PANE\|UNRECOGNISED_PANE)` |
| host guard | `dori guard --loop 1` | `^HOST_GUARD` |
| freshness | `dori freshness --loop 5` | `^(NUDGED\|POSTED\|NO-REPORT\|PENDING-REPORT\|STALE-REPORT\|STALLED\|JOURNAL-ERROR\|WORKING-WHILE-PAUSED)` |
| Slack inbound (Slack only) | `dori inbound slack --loop 1` | `^INBOUND` |
| Telegram inbound (Telegram only) | `DORI_TELEGRAM_TOKEN=… DORI_TELEGRAM_OWNER_ID=… dori inbound telegram --loop 1` | `^INBOUND` |
| presence (opt-in) | `dori presence discord` (or retained Slack: `dori presence slack`) | `^PRESENCE_` |

The supported public receiver is **`dori inbound discord`**. It requires the owner's bot token and the two configured IDs, polls every three seconds by default, and emits only that owner's messages from the exact channel. `--loop` is in minutes: `--loop 0.1` polls every six seconds and `--loop 0` runs once. First start saves a latest-message baseline without replay; wait for `INBOUND_READY discord owner=... channel=... bot=...`, then send a fresh owner message. Later records are `INBOUND discord <channel> <message> from=owner ref=<id|-> <JSON text>`, followed by `INBOUND_REPLY` for available reply context and ordered `INBOUND_ATTACHMENT` records for attachments, including voice metadata ([format](scripts.md#dori-inbound-discord---loop-minutes---gateway)). Attachment-only messages keep text `""`; metadata delivery starts no transcription. An owned per-channel cursor survives an explicit restart.

Use the [concrete native monitor argv recipe](../../../docs/releases.md#discord-owner-intake), which loads the protected token file only inside the child shell and inherits the two non-secret IDs from the owning OMP environment. No private helper, external CLI watcher, Node or agent-messenger is required. Startup checks bot authentication, Message Content Intent and View Channel/Read Message History access. Non-owner/bot/webhook/system messages do not become owner requests. Send permissions are required only for replies. See `scripts.md` for cursor/error details.

Discord REST inbound polling and message sending alone do not keep the bot online. While Dori is used, an explicitly enabled `dori presence discord` Gateway keeper must remain running under native monitor supervision, with `DORI_DISCORD_TOKEN` supplied only in its child environment. Genuine Gateway READY/RESUMED produces `PRESENCE_READY`; only the first actual heartbeat acknowledgement per connection produces `PRESENCE_ACK`, while later acknowledgements update lifecycle state silently. Explicit monitor stop ends its sockets/retries and prints `PRESENCE_STOPPED discord`, so offline is the intended result. The inbound watcher is a separate opt-in process. Do not restore unrelated paused watchers or the maintainer updater to fix presence. See [presence operation and errors](../../../docs/releases.md#discord-online-presence).

## 6. First look around

Once the bot is live, explore the machine: running coding-agent sessions, the tools in use, recent logs. Write what you find into memory, and adopt any running lanes with `dori adopt`.
