# Configuration reference

Everything the owner can set lives in one TOML file. This page lists every section and every key
the hub accepts. A complete example you can copy is in
[`config-example.toml`](config-example.toml); a test parses it with the hub's own parser, so it
always matches this build.

## Files and folders

| What | Where | Override |
|---|---|---|
| Config file | `~/.config/cataly/config.toml` | `$XDG_CONFIG_HOME/cataly/config.toml` |
| State folder (store `cataly.db`, `logs/`, `files/`, `backup/`, `hub.lock`) | `~/.local/state/cataly` | `$XDG_STATE_HOME/cataly` |
| Control socket | `$XDG_RUNTIME_DIR/cataly/hub.sock` | falls back to `/tmp/cataly-<uid>/hub.sock` when `XDG_RUNTIME_DIR` is unset or the path is too long for a socket |
| Token files | `secrets/` next to the config file | the `token_file` / `key_file` key of each section |
| Provider keys for the service | `secrets/service.env` next to the config file | none (see [`cataly service enable`](#cataly-service-enable)) |

`HOME` must be set to an absolute path. An `XDG_*` variable that is not an absolute path is ignored,
as the XDG rules require. `cataly setup` shows which of these came from the environment.

The config file must be a regular file owned by you, with no access for group or others
(`chmod 600`), not a symlink, not hard-linked, UTF-8, and at most 1 MiB. A missing file means
built-in defaults for everything. `cataly setup` applies the same rule: it refuses an existing file
that breaks it and names the fix (for example `chmod go=`). The folders it owns (the config folder,
`secrets/` and the state folder) it creates with mode `700` and its files with mode `600`, whatever
your umask; one of those folders that is yours but open to group or others is tightened to `700`.

### Tokens and keys

Tokens never go into the config file. Each one sits in its own owner-only file (same rules as the
config file: yours, mode `600`, regular file, one link, at most 64 KiB, surrounding whitespace
trimmed, must not be empty). Default locations, next to the config file:

| Secret | Default file | Key that moves it |
|---|---|---|
| Discord bot token | `secrets/discord-token` | `[discord] token_file` |
| Telegram bot token | `secrets/telegram-token` | `[telegram] token_file` |
| Slack tokens, one per line: `app=xapp-…` and `api=xoxb-…` (app role) or `api=xoxp-…` (member role) | `secrets/slack-tokens` | `[slack] token_file` |
| Voice provider key | `secrets/voice-key` | `[voice] key_file` |
| Usage collector key (optional) | none | `[usage] key_file` |

Every `token_file` / `key_file` value must be an absolute path. A token file that is missing, empty,
owned by someone else or readable by others is refused, and the error names only the path.

## Checking, writing and applying the file

- `cataly config check [--file <path>]` validates a file without applying it. Validation is strict:
  an unknown key, a wrong type or an out-of-range value is an error, and every error names its
  setting path, such as `jobs.nightly.cron: never fires`. Nothing in an invalid file is applied.
- `cataly config reload` (or `SIGHUP` to the hub) reads the file again. A valid file replaces the
  running configuration as a whole; the log level changes at once, and a job whose trigger changed
  starts a new schedule. An invalid file is refused, the previous configuration stays in force, a
  `config.invalid` event is sent, and the `config` health check warns until a valid file is applied
  (then `config.valid`).
- The hub reads the file when it starts. Editing the file does nothing until a reload or restart.

### `cataly setup`

One command for the first run and for every later change of what it manages. At a terminal it
asks only what Discord forces, then fills in defaults without asking:

1. **Bot token.** In the [Developer Portal](https://discord.com/developers/applications): **New
   Application**, name it, **Create**; **Bot**, **Reset Token**, copy it. Setup asks for it without
   showing it, checks it with Discord (`GET /users/@me`) and saves it in the token file
   (`[discord] token_file`, default `secrets/discord-token`, mode `600`). A script saves it there
   itself; the token is never read from the command line.
2. **Message Content intent**: switched on through `PATCH /applications/@me` (Discord allows it for
   a bot in fewer than 100 servers). If Discord does not take it, setup names the place: Developer
   Portal, your application, **Bot**, **Privileged Gateway Intents**, **Message Content Intent**.
3. **Invite link**: `https://discord.com/oauth2/authorize?client_id=<application>&scope=bot&permissions=2252126231268432`,
   exactly the permissions Cataly uses (Manage Channels, View Channels, Send Messages, Read Message
   History, Add Reactions, Create Public Threads, Send Messages in Threads, Manage Threads, Pin
   Messages; the ops panel pins its message with it and works unpinned without). Setup
   reads the bot's servers every 3 s until it joins (10 minutes at a terminal; `--wait 5m` in a
   script, none by default). With several servers it asks which (`--guild <id>`).

Then the defaults, each applied only where the config says nothing yet:

| What | Default | Flag |
|---|---|---|
| Owner | the application's owner (the team's owner for a team application) | `--owner <id>` |
| Channels | the text channels `#cataly` (your talks with the lead) and `#cataly-ops` (the [status panel and alerts](#ops)) are reused, missing ones created; no other channel is touched | |
| Lead | the model OMP starts with (`omp config get modelRoles`) | `--lead-model provider/id`, `--lead-cwd` |
| Remote approvals | on: OMP's permission requests get buttons; only your presses count | `--approvals on\|off` |
| Bot profile | Cataly's avatar and banner on the bot (`PATCH /users/@me`) and the avatar as the application's icon (`PATCH /applications/@me`), each only where there is none or still the one Cataly set; your own images are kept | `--profile` re-applies Cataly's |
| Home backup | to `<gh login>/cataly-home`, private, created if absent, when `gh` is logged in (see [Home backup](#home-backup)) | `--backup on\|off`, `--backup-repo owner/name` |
| Jobs | `[jobs.health]` and `[jobs.pressure]` with their defaults, notices to `#cataly-ops`, unless a job of that kind exists | |
| Service | the user service, enabled and started (see [`cataly service enable`](#cataly-service-enable)); only for an installed release | `--service on\|off` |

Setup then shows one short summary (a `+` marks what this run changes) and asks once; nothing
changes before you say yes. `--yes` says yes in a script; without it and without a terminal setup
only reports. A run on a configured machine shows what is set and changes nothing. Setup records
which avatar and banner it set in `discord-profile.json` in the state folder, so it can tell them
from images you set yourself.

On yes it creates the missing channels, sets the bot's images, prepares the home backup, writes the
config file, enables the service, and asks a running hub to reload. It writes the config without
touching anything else: comments, other keys and unknown keys stay, only the lines it manages
change. It snapshots the file (identity and SHA-256), re-checks the snapshot just before an atomic
replace (or a create that never overwrites), and reads the file back; your own edits made
meanwhile are never clobbered. `--expect <hash>` refuses a file whose SHA-256 is no longer the one
a `--json` report showed as `before`, for scripts that edit an existing file.

`--json` never asks and prints one report: `file`, `action` (`create`, `update`, `keep`),
`applied`, `before` and `after` digests, `valid`, `summary` (each line with `change`), `discord`
(`stage`, bot, application, `message_content`, `invite`, `guilds`, `guild`, `channels`, `owner`
with its source), `backup`, `sources` (each setting below with its value and where it comes from)
and `notes`. A step that still needs you ends the run with exit status 1, `discord.stage` naming
it (`token`, `intent`, `guild`, `channels`, `owner`) and `discord.next` saying what to do.

Setup runs the Discord steps unless the config or the flags name only a Telegram or Slack owner.
These flags write their keys as given:

| Setup option | Key it writes |
|---|---|
| `--log-level` | `[hub] log_level` |
| `--omp` | `[omp] path` |
| `--discord-token-file` | `[discord] token_file` |
| `--telegram-token-file`, `--telegram-owner`, `--telegram-group`, `--telegram-topic` | `[telegram] token_file`, `owner`, `group`, `topic` |
| `--slack-token-file`, `--slack-role`, `--slack-owner` | `[slack] token_file`, `role`, `owner` |
| `--fallback-on` | `[fallback] on` |
| `--fallback-chain` (comma-separated `provider/id`) | `[fallback.chains] default` |
| `--lead-model` (`provider/id`), `--lead-cwd` (absolute folder) | `[lead] model`, `cwd` |
| `--lead-name`, `--lead-persona` | `[lead] name`, `persona` |

A new file also gets `[hub] log_level = "info"` and `[omp] path = "omp"`.

### `cataly service enable`

Writes and starts the user service (systemd user unit on Linux, launchd agent on macOS). It runs
`~/.local/bin/cataly hub` for an `install.sh` install, and the binary inside the platform package
(`…/node_modules/cataly-<platform>/cataly hub`) for an npm or Bun install: both paths stay the same
across updates, and `cataly service refresh`, which update runs, writes the same one. A service
does not see your shell's environment, so it:

- sets `[omp] path` to the absolute path of OMP when the config names it bare;
- writes one `PATH=` line into the unit, made of the folders where `omp`, `bun`, `gh`, `git` and
  the Tern executable are found now, then `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  repeats and folders with `:`, `"`, `\` or control characters are left out. The line is printed;
- reads provider keys from `secrets/service.env` next to the config file (owner-only, mode `600`).
  A new file gets each `[sessions] credentials` name found in your current environment as
  `NAME=value`, and the others as commented lines to fill in. An existing file is never changed;
  the names it lacks are printed. Restart the service after editing it.

## Value formats

- **Duration**: a string of whole numbers with units `s`, `m`, `h`, `d`, summed: `"30s"`, `"5m"`,
  `"1h30m"`, `"2d"`. No decimals, no bare numbers.
- **Discord ID**: a string with the decimal ID, such as `"100000000000000001"`.
- **Model**: `provider/id`, such as `"anthropic/claude-sonnet-4-5"`; no spaces.
- **Path**: where a key says *absolute*, a relative path is an error.
- **Name** (jobs and destinations): 1 to 128 letters, digits, `.`, `@`, `_` or `-`, starting with a
  letter or digit.

---

## `[hub]`

| Key | Type | Default | Allowed | What it does | Setup |
|---|---|---|---|---|---|
| `log_level` | string | `"info"` | `error`, `warn`, `info`, `debug` | Detail of `logs/hub.log`. Changes on reload. | `--log-level` |
| `language` | string | `"ko"` | `ko` (Korean), `en` (English) | Your one language (DESIGN A19): every fixed text Cataly writes to you, such as the [update notice](#update-and-usage), uses it unless you give your own wording. | |

```toml
[hub]
log_level = "info"
language = "ko"
```

## `[setup]`

What `cataly setup` remembers between runs. You rarely edit it by hand.

| Key | Type | Default | Allowed | What it does | Setup |
|---|---|---|---|---|---|
| `backup` | boolean | `true` | | `false` once you turned the [home backup](#home-backup) off before it existed; a plain re-run then leaves it off instead of offering it again. | `--backup off` writes `false`; `--backup on` (or `--backup-repo`) sets it back to `true` and plans the backup |

```toml
[setup]
backup = false
```

## `[omp]`

| Key | Type | Default | Allowed | What it does | Setup |
|---|---|---|---|---|---|
| `path` | string | `"omp"` | an absolute path, or a command name without `/` looked up on `PATH` | The OMP executable the hub starts sessions with. | `--omp` |

```toml
[omp]
path = "/home/me/.bun/bin/omp"
```

## `[sessions]`

Settings for every OMP session the hub starts (lead, lanes and helper roles).

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `cap` | integer | `8` | 1–32 | Live OMP sessions at most, all roles together. |
| `credentials` | list of strings | `[]` | environment variable names: upper-case letters, digits, `_`, not starting with a digit, not starting with `CATALY_` | Variables passed from the hub's environment to OMP (provider keys). Nothing else is passed. |
| `extra_flags` | list of strings | `[]` | `--name` or `--name=value` only | Extra OMP command-line flags. Refused: flags the hub sets itself (`--mode`, `--session-dir`, `--resume`/`-r`, `--continue`/`-c`, `--restore`, `--fork`, `--print`/`-p`, `--goal`, `--plan`, `--approval-mode`, `--auto-approve`, `--yolo`, `--cwd`, `--config`, `--model`, `--thinking`, `--append-system-prompt`, `--system-prompt`, `--tools`, `--max-cost`, `--no-session`), `--extension`, and anything starting with `approval` or containing `approve`. |
| `spend_phrases` | list of strings | `[]` | any; matched case-insensitively, blanks dropped | Extra phrases that mark an OMP dialog as an offer to spend money, beside the built-in ones. Such dialogs are never accepted for you. |
| `runtime` | string | `"headless"` | `headless`, `tern` | Where new sessions run. A stored session keeps the runtime it started with. |
| `tern` | string | `"tern"` | non-blank; absolute path or name on `PATH` | The Tern executable, used when `runtime = "tern"`. |
| `tern_session` | string | none (the session shown) | any non-blank name | The Tern session new blocks open in. |

```toml
[sessions]
cap = 6
credentials = ["ANTHROPIC_API_KEY"]
extra_flags = ["--no-skills"]
```

## `[lead]`

Present means the hub keeps one standing lead session. Absent means no lead.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `model` | string | **required** | `provider/id` | The lead's model. |
| `thinking` | string | OMP's default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto` | Thinking level. |
| `cwd` | string | your home folder | absolute path | Working folder of a new lead session. A resumed lead keeps the folder its session recorded (a real folder you own), even when this setting or the default changed since. |
| `session_id` | string | none | any non-blank | The lead resumes exactly this OMP session. |
| `instructions` | string | none | absolute path to an owner-only file | Role instructions appended to the lead's system prompt. |
| `name` | string | `Cataly` | any non-blank | How the assistant introduces itself in chat. The default keeps the built-in voice. |
| `persona` | string | none | any text, a few lines | Personality and tone guidance appended to the lead's instructions. Unset keeps the built-in voice. |
| `autostart` | boolean | `true` | | Start the lead when the hub starts. |

```toml
[lead]
model = "anthropic/claude-sonnet-4-5"
thinking = "medium"
cwd = "/home/me/work"
# name = "Cataly"     # how the assistant introduces itself; the default keeps the built-in voice
# persona = ""        # personality guidance appended to the lead's instructions
```

## `[fallback]`

What OMP may do when a model fails. Written into OMP's settings for hosted sessions only when set;
unset keeps OMP's own setting. A fallback only ever moves to another configured model; it never
redeems a reset, buys credits or turns on overage.

| Key | Type | Default | Allowed | What it does | Setup |
|---|---|---|---|---|---|
| `on` | string | unset | `any`, `usage-limit`, `except-usage-limit` | Which errors make OMP fall back (OMP `retry.fallbackOn`). | `--fallback-on` |
| `chains.<role>` | list of strings | none | `provider/id` models | Ordered models OMP may move to for that role (OMP `retry.fallbackChains`). | `--fallback-chain` writes `chains.default` |

```toml
[fallback]
on = "usage-limit"

[fallback.chains]
default = ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]
```

## `[discord]`

The Discord bot: where its token is, and intake (which messages reach the lead). Intake runs only
when both `owner` and `channels` are set; setting one without the other is an error.

| Key | Type | Default | Allowed | What it does | Setup |
|---|---|---|---|---|---|
| `token_file` | string | `secrets/discord-token` | absolute path | The bot token file. | `--discord-token-file` |
| `guild` | string | none | Discord ID | Your server. Needed for destinations that name a channel by name, and for voice. | `--guild` |
| `api_base` | string | Discord's API | `http(s)://` on localhost only | Test override of the API address. | |
| `owner` | string | none | Discord user ID | Your account. | `--owner` (default: the application's owner) |
| `channels` | list of strings | `[]` | Discord IDs, at most 256, duplicates dropped | Watched channels, threads, DMs and forums. | `#cataly`, found or created |
| `follow_threads` | boolean | `true` | | Also take threads under watched channels. | |
| `home` | string | the one watched channel, if there is exactly one | one of `channels` | Where the lead's questions go. | `#cataly` when there are several |
| `remote_approvals` | boolean | `false` | | Let you approve OMP permission requests by button, on a card in `[hub] language` with the command in a code block. Cataly's own tools and a fixed list of read-only commands (`ls`, `cat`, `grep`, `git status`, `git log`, `git diff` and the like) never ask; anything else still does. | `--approvals on\|off` (setup's default: on) |
| `form_default_after` | duration | `"3m"` | 1s–1h | A question with one recommended choice takes it after this long. | |
| `category` | string | `Cataly` | at most 100 characters; empty means no grouping | The channel category setup creates or reuses and puts `#cataly` and `#cataly-ops` into; existing channels found at the server root are moved into it. Empty keeps the channels at the root. | |
| `profile` | boolean | `true` | | `cataly setup` puts Cataly's avatar and banner on the bot where the bot has none (or still has Cataly's older ones); an image you set yourself is kept. Off: setup leaves the profile alone. | `--profile` re-applies them |
| `away` | duration | `"3h"` | 1s–720h | You count as back when your message comes this long after your previous one. | |
| `others` | list of strings | `[]` | subset of `channels` | Watched rooms where you talk with other people. | |
| `others_alert` | duration | `"120m"` | 1s–168h | A message from someone else in those rooms unanswered this long is reported once. | |
| `others_drop` | duration | `"24h"` | 1s–720h | Such entries older than this are dropped silently. | |

```toml
[discord]
owner = "100000000000000001"
channels = ["100000000000000010"]
```

## `[telegram]`

Intake runs when `owner` is set. IDs may be written as numbers or as strings.

| Key | Type | Default | Allowed | What it does | Setup |
|---|---|---|---|---|---|
| `token_file` | string | `secrets/telegram-token` | absolute path | The bot token file. | `--telegram-token-file` |
| `api_base` | string | Telegram's Bot API | localhost only | Test override. | |
| `owner` | integer or string | none | positive user ID | Your account; your DM with the bot is taken. | `--telegram-owner` |
| `group` | integer or string | none | negative chat ID | The one group or supergroup taken besides your DM. | `--telegram-group` |
| `topic` | integer or string | none | positive; needs `group` | The one forum topic of that group taken (`1` is General). | `--telegram-topic` |
| `chats` | list | `[]` | non-zero chat IDs | Further chats the hub may send to. | |
| `profile` | boolean | `true` | | Clear the bot's name at start. | |

```toml
[telegram]
owner = 100000001
group = -1000000000001
topic = 1
```

## `[slack]`

Intake runs when `owner` is set. Only your messages, and those of members in `allow`, are taken.

| Key | Type | Default | Allowed | What it does | Setup |
|---|---|---|---|---|---|
| `token_file` | string | `secrets/slack-tokens` | absolute path | The tokens file (see [Tokens](#tokens-and-keys)). | `--slack-token-file` |
| `api_base` | string | Slack's API | localhost only | Test override. | |
| `role` | string | `"app"` | `app`, `member` | `app`: the bot user, sees only conversations it is in. `member`: the app's user token, sees what that member sees (needs a paid seat). | `--slack-role` |
| `owner` | string | none | member ID starting with `U` or `W`, such as `U0123ABCD` | Your account. | `--slack-owner` |
| `allow` | list of strings | `[]` | Slack member IDs | Further members whose messages are taken. | |

```toml
[slack]
role = "app"
owner = "U0000OWNER"
```

## `[context]`

Extra lines added to requests sent to the lead. Both are off by default.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `facts` | boolean | `false` | | Add a line of channel facts. |
| `lookup` | boolean | `false` | | Add lines from earlier conversation in the room. |
| `lookup_days` | integer | `30` | 1–3650 | Stored rows for the lookup are kept this many days. |
| `notes.<relay>:<room>` | string | none | key: `discord:`, `telegram:` or `slack:` followed by the room ID; value: one line, 1–500 characters, no control or direction-override characters | Your one-line note about that room, shown with its requests. |

```toml
[context]
facts = true

[context.notes]
"discord:100000000000000010" = "the release room"
```

## `[voice]` and `[transcribe]`

`[voice]` is the Discord voice assistant. It is off unless `enabled = true`; while off, its other
keys are not read, but a key that is not in the table below is an error at load time either way.
When enabled, a missing or invalid voice key turns voice off and names the
field, but the rest of the configuration still applies. A build without the `voice` feature refuses
`enabled = true` the same way. Voice also needs `[discord] guild` and `[discord] owner`.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `enabled` | boolean | `false` | | Turns voice on. |
| `voice_channel` | string | **required** | Discord ID | Voice channel to join. |
| `text_channel` | string | **required** | Discord ID | Text channel for the call's text. |
| `speech_model` | string | **required** | 1–64 letters, digits, `.`, `-`, `_` | Realtime speech model. |
| `backend_model` | string | **required** | same | Model that answers. |
| `summary_model` | string | **required** | same | Model that summarises. |
| `voice` | string | **required** | same | Voice name. |
| `backend_prices` | table | **required** | `input`, `cached_input`, `cache_write`, `output`: USD per million tokens, 0 or more, all required | Prices of the backend model, for the spending cap. |
| `summary_prices` | table | **required** | same | Prices of the summary model. |
| `search_price` | number | **required** | USD, 0 or more | Price of one web search. |
| `speech_price_per_minute` | number | none | USD, 0 or more | Price of speech per minute. |
| `reasoning_effort` | string | `"low"` | `minimal`, `low`, `medium`, `high` | Reasoning effort of the backend model. |
| `preferences` | string | `""` | any | Your standing preferences for the assistant. |
| `zone` | string | `"UTC"` | IANA zone | Time zone for the daily cap. |
| `daily_minutes` | integer | `30` | 1–1440 | Call minutes per day. |
| `total_minutes` | integer | `0` (no total cap) | 0–4294967295 | Call minutes in all. |
| `spending_cap_usd` | number | `3.0` | above 0 | Spending cap. |
| `idle_close_seconds` | integer | `120` | 1–3600 | Leave the call after this much silence. |
| `wake_dbfs` | number | `-45.0` | between -120 and 0, exclusive | Sound level that counts as speech. |
| `transport` | string | `"websocket"` | `websocket`, `webrtc` | Connection to the speech provider. |
| `api_base` | string | `"https://api.openai.com"` | URL | Speech provider address. |
| `key_file` | string | `secrets/voice-key` | absolute path | Provider key file. |

`[transcribe]` is the owner command behind `cataly transcribe <file|url>`; the audio file's path is
appended to it. A URL is downloaded first.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `command` | list of strings | none | program first, non-empty | The transcription command. |
| `max_mib` | integer | `25` | 1–1024 | Largest download, in MiB. |

```toml
[transcribe]
command = ["/usr/local/bin/whisper-cli", "--model", "base"]
```

## `[lanes]`

Defaults for lanes (worker sessions the lead opens) and the rules they run under.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `model` | string | OMP's default | `provider/id` | Model of new lanes. |
| `cwd` | string | none | absolute path | Default working folder of new lanes. |
| `max` | integer | `20` | 0–1000; `0` = no limit | Live lanes at most. |
| `start_budget` | duration | `"180s"` | 10s–30m | How long a lane may take to start. |
| `objection` | duration | `"5m"` | 1s–24h | Window in which you can object to a proposed lane. |
| `ceiling_minutes` | number | no ceiling | finite, 0 or more | Default run-time ceiling per lane. |
| `ceiling_tokens` | number | no ceiling | finite, 0 or more | Default token ceiling per lane. |
| `ceiling_cost` | number | no ceiling | finite, 0 or more | Default cost ceiling per lane. |
| `post_kinds` | list of strings | all five | `progress`, `stuck`, `waiting`, `stopped`, `finished` | Report kinds posted to the lane's thread automatically. |
| `post_raw` | boolean | `true` | | Post the lane's own report text (else only summaries). |
| `thread_member` | boolean | `true` | | Add you to lane threads the hub creates. |
| `identities.<owner/name>` | string | none | an email address | The commit identity the policy check expects in that repository. |

`[lanes.oversight]`: when the hub nudges a lane. The reminders and the stall alert must come in
order: `first_reminder` < `second_reminder` < `stall`.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `enabled` | boolean | `true` | | Turns oversight on. |
| `first_reminder` | duration | `"10m"` | 1s–24h | First reminder to a silent lane. |
| `second_reminder` | duration | `"20m"` | 1s–24h | Second reminder. |
| `stall` | duration | `"40m"` | 1s–24h | The lane is reported stalled. |
| `busy` | duration | `"20m"` | 1s–24h | A lane working without a break this long… |
| `quiet` | duration | `"20m"` | 1s–24h | …and without progress this long is judged stuck. |
| `sweep` | duration | `"5m"` | 1s–24h | How often oversight looks. |
| `thread_quiet` | duration | `"20m"` | 1s–24h | A progress report posts to the thread only after this quiet time. |

`[lanes.shell]`: shell rules for lanes. Patterns are regular expressions matched against the whole
command.

| Key | Type | Default | What it does |
|---|---|---|---|
| `deny` | list of patterns | `[]` | Commands no lane may run. |
| `allow` | list of tables | `[]` | Each `{ lanes = "<glob>", patterns = [...] }` lets lanes whose key matches the glob (only `*` is special; `lanes` is required) run matching commands. |

```toml
[lanes]
model = "anthropic/claude-sonnet-4-5"
max = 4

[lanes.shell]
deny = ["git push --force.*"]

[[lanes.shell.allow]]
lanes = "web-*"
patterns = ["git push origin web-.*"]
```

## Coordination: `[coord]`

Named slots, the planner, the reviewer, lane event commands, publish folders and boards.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `board` | list of strings | `[]` | `discord:<channel id>` (17–20 digits), `telegram:<chat>[/<topic>]`, `slack:<workspace>/<conversation>` | Where the board is posted. |

`[coord.slots]`

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `count` | integer | `1` | 1–64 | Slots per name unless `sizes` names it. |
| `load` | integer | `80` | 1–10000 | Slot grants wait while the one-minute load per core is at or above this per cent. |
| `sizes.<name>` | integer | `count` | 1–64; name: letter or digit, then letters, digits, `_`, `.`, `-`, at most 64 | Slots for that name. |

`[coord.planner]`

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `enabled` | boolean | `true` | | Turns the planner on. |
| `interval` | duration | `"1h"` | 1m–24h | Time between planner passes. |
| `max_open` | integer | `3` | 0–1000 | Planned lanes open at once at most. |
| `max_starts` | integer | `2` | 0–100 | Lanes started per pass at most. |
| `notes_hour` | integer | none | 0–23 | Local hour of the daily owner-notes refresh. |
| `import_label` | string | `"cataly"` | | GitHub issue label imported as work items. |
| `decision_label` | string | `"needs-decision"` | | Label marking an item that needs your decision. |
| `queue_expiry` | duration | `"24h"` | 1h–720h | A queued launch expires after this. |

`[coord.review]`

| Key | Type | Default | What it does |
|---|---|---|---|
| `model` | string | OMP chooses | Model of the built-in reviewer. |
| `command` | list of strings | none | A custom reviewer command that replaces the built-in one. Placeholders as for events. |

The built-in reviewer reads only: it runs with the lanes' OMP overlay, the tools `read`, `grep` and
`glob`, every other tool call refused, and a spend cap of `[lanes] ceiling_cost` (2 USD when unset).
The hub fetches the pull request's text for it.

`[coord.events]`: commands run on lane events, never through a shell. Each is a non-empty list of
non-empty strings; elements may contain `{key}`, `{text}`, `{evidence}`, `{pr}`, `{repo}`,
`{number}`, `{head}`.

| Key | What triggers it |
|---|---|
| `finished` | A lane finished. |
| `report` | A lane reported. |
| `dead` | A lane died. |

`[[coord.publish]]`: folders whose files may be published, each a table.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `dir` | string | **required** | absolute path | The folder. |
| `url` | string | none | `http(s)://` without credentials, query or fragment | Its public address. |

```toml
[coord]
board = ["discord:100000000000000011"]

[coord.slots]
count = 2
sizes = { build = 1 }

[coord.planner]
max_open = 2
```

## `[outgoing]`

Checks on text the hub sends. Text with an unfilled `{field}`, a placeholder word or a banned
character is refused and the reason names what matched.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `placeholder_words` | list of strings | `[]` | any; matched case-insensitively | Words that must not appear (`TODO`, `lorem`). |
| `banned_characters` | list of strings | `[]` | each exactly one character | Characters that must not appear. |

```toml
[outgoing]
placeholder_words = ["TODO", "lorem ipsum"]
banned_characters = ["—"]
```

## `[limits]`

The account-limits view (`cataly limits`), and the cache the quota job shares.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `enabled` | boolean | `false` | | Turns the view on; off, `cataly limits` is refused. |
| `cache` | duration | `"5m"` | 1m–24h | How long fetched usage data counts as fresh. |
| `warn_percent` | integer | none | 1–100 | Shows each window's headroom to this level. |

```toml
[limits]
enabled = true
warn_percent = 80
```

## `[health]`

| Key | Type | Default | What it does |
|---|---|---|---|
| `ignore` | list of strings | `[]` | Check names left out of the health status and the `health` job, such as `bridge`, `omp`, `config`, `discord.token`, `job.<name>`, `file.<path>`. |

Each check reports `ok`, `info` or `warn`, and a warning names its fix:

| Check | Warns when | Fix it names |
|---|---|---|
| `config` | the file on disk is invalid and not applied | fix the file, then `cataly config reload` |
| `omp` | the OMP found cannot host sessions | install OMP 19.1.1 or newer, or set `[omp] path` |
| `bridge` | OMP's extension folder does not link this version's bridge | `cataly status --install` |
| `discord.token`, `telegram.token`, `slack.token` | a messenger is configured but its token file is missing, empty or not owner-only | put the token in that file, mode `600` |
| `lead` | a messenger is configured but there is no `[lead]`: messages wait with nobody to answer | `cataly setup --lead-model provider/id`, then `cataly config reload` |
| `job.<name>` | a scheduled job has had no good tick for twice its cadence | `cataly job list` and the hub log |
| `file.<path>` | a file watched by a `health` job is missing or older than its limit | check the path in the health job |

```toml
[health]
ignore = ["bridge"]
```

## `[update]` and `[usage]`

Each newer stable release is announced once, never one you rolled back from. The notice only
tells you; `cataly update` installs (it restarts a running hub on the new version; see the README).
After the hub first runs a different version than its previous run, it says once that it was
updated (or rolled back) and which sessions it resumed; an ordinary restart says nothing. Both go
out like any job post (no mentions) and are not sent to the lead as work. Without `destinations`
they go to your home room: the `[discord]` home channel, else the `[telegram]` group (and topic)
or your DM. With neither, they stay in the event log; for Slack, name a destination.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `update.check` | boolean | `true` | | Daily check for a newer stable release; off means no request is ever made. |
| `update.first_after` | duration | `"10m"` | 1s–24h | First check after the hub starts. |
| `update.api_base` | string | GitHub's API | localhost only | Test override. |
| `update.template` | string | see below | fields `{current}`, `{latest}`, `{url}`; `{{`/`}}` for braces | The notice wording; line breaks are kept. |
| `update.updated_template` | string | see below | fields `{previous}`, `{latest}`, `{sessions}` | The wording after an update; a rollback keeps its default. |
| `update.destinations` | list of strings | your home room | names from `[destinations]`, `log` | Where the notice and the update message go instead. |
| `usage.enabled` | boolean | `false` | needs `endpoint` | Sends usage counts. There is no default collector. |
| `usage.endpoint` | string | none | URL | OTLP/HTTP logs endpoint, such as `https://collector.example/v1/logs`. |
| `usage.key_file` | string | none | absolute path | Owner-only file with the collector's key, sent as a bearer token. |

Default notice, in `[hub] language` (`ko`, then `en`):

```text
새로운 버전이 나왔습니다! 보스. 콘솔 창에 `cataly update` 명령어를 입력해주세요.
{current} -> {latest} {url}

A new version is out, boss. Run `cataly update` in a terminal.
{current} -> {latest} {url}
```

After an update and after a rollback (`{sessions}` says how the lead came back and which lanes run
again, such as `lead를 이어서 열었습니다. lane 2개를 이어서 열었습니다: a, b.`; a lead that started
fresh says so and why, such as `lead는 이전 대화를 이어가지 못해 새로 시작했습니다(...)`; or nothing):

```text
{latest} 버전으로 업데이트했습니다. 보스, 감사합니다!
{previous} -> {latest}
{sessions}

{latest} 버전으로 되돌렸습니다.
{previous} -> {latest}
{sessions}

Updated to {latest}. Thanks, boss!
{previous} -> {latest}
{sessions}

Rolled back to {latest}.
{previous} -> {latest}
{sessions}
```

```toml
[update]
check = true
# template = "Cataly {latest} is out (you have {current}): {url}"
# destinations = ["phone"]
```

---

## `[ops]`

The ops room, `#cataly-ops` after setup: one status panel and the few alerts worth a ping, kept
apart from your talks with the lead. Events a job routes to this destination are not posted as
lines; the panel words them, in `[hub] language`, and the event log keeps them as before.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `destination` | string | `"cataly-ops"` when that is a Discord destination | a Discord destination in `[destinations]`; `""` turns the room off | Where the panel and alerts go. |
| `mute` | duration | `"1h"` | 1m–24h | How long the mute button silences new alerts. |
| `alerts.pressure` | boolean | `true` | | Post when the host has been in alert for five minutes (`pressure.alert`). |
| `alerts.quota` | boolean | `true` | | Post when the quota gate holds a provider (`quota.hold`). |
| `alerts.jobs` | boolean | `true` | | Post when a job routed here fails twice in a row. |
| `alerts.backup` | boolean | `true` | | Post when a backup is refused (`backup.refused`). |
| `alerts.github` | boolean | `true` | | Post GitHub news: `github.pr`, `github.notification`, `pr.feedback`, `pr.check_failed`, `pr.merged`. |
| `alerts.mail` | boolean | `true` | | Post new items of an `items` job, such as a mail watch (`items.new`). |

**The panel** is one embed message: created once with Cataly's banner and thumbnail, pinned when
the bot may pin (the Pin Messages or Manage Messages permission; without it the panel stays
unpinned), and then edited in place, only when something shown changed and at most once a
minute, like the [board](#coordination-coord). After an uncertain create it is never posted again:
it stays in doubt until the lead names the message it found (board destination
`ops:<channel id>`).
Its colour is the worst state: green when all is fine, amber when something is worth a look (host
busy, a limit of a provider that is not held at 90 % or more, a job with a failure, the lead in
error), red when it needs you (host in alert, a held provider a live session uses, the lead held
by the quota gate or its provider's limit, a job failing twice or waiting for your ack). A held
provider no live session uses does not change the colour: under the summary, a held provider gets
a line naming the held providers and saying whether a live session uses one or sessions on the
other providers start normally. It shows:

- 🖥️ host: load bar and per cent, free memory and disk, live sessions (the lead and the lanes)
  of `max_sessions` (load and memory rounded to 5 %, so noise does not edit the panel);
- 🔋 usage: one line per provider, by the name OMP reports, with its most used limit, a bar, the
  per cent and the reset time; held providers marked;
- 👥 sessions: the lead's state and model, lanes running and waiting;
- 🛠️ jobs: all fine, or which jobs need attention;
- 📮 recent: the last three events routed here (busy and ready changes left out), with relative
  times;
- the last update as a relative time under the summary, and the version in the footer with the
  update time beside it.

Buttons, for the owner only (anyone else gets a private refusal): 🔄 refresh (once a minute at
most), 📊 usage details (a private reply with every limit), 🔕 mute (silences new alerts for
`mute`; press again to unmute; the panel keeps updating).

**Alerts** are small embeds with the thumbnail, each kind at most once an hour and none while
muted. One whose condition clears (`pressure.clear`, `quota.released`, `backup.clean`, the job
working again) is edited to show it resolved and when, instead of a new post. Busy and ready
changes never post; they only change the panel.

```toml
[ops]
mute = "30m"
alerts = { github = false }
```

---

## `[destinations.<name>]`

Where job events go besides the store and the event log. The name `log` is reserved: it is the
built-in local destination and may be listed in a job's `destinations`. Every destination needs
`kind`.

| Kind | Keys | Allowed |
|---|---|---|
| `command` | `argv` (**required**) | non-empty list of non-empty strings. The command runs with the event as JSON in the `CATALY_EVENT` environment variable. |
| `discord` | `channel` (**required**) | a channel or thread ID, or a channel name (`#name` or `name`) when `[discord] guild` is set |
| `telegram` | `chat` (**required**), `topic` | `chat`: non-zero chat ID; `topic`: 1–2147483647. Both as an integer or a string, as in `[telegram]` |
| `slack` | `channel` (**required**), `thread` | `channel`: `<workspace>/<conversation>`, such as `T0123ABCD/C0456EFGH`; `thread`: a message timestamp such as `1700000000.000100` |

```toml
[destinations.phone]
kind = "discord"
channel = "100000000000000012"

[destinations.pager]
kind = "command"
argv = ["/usr/local/bin/notify"]
```

## `[jobs.<name>]`

Every job has `kind` and these common keys:

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `kind` | string | **required** | `cron`, `once`, `probe`, `github`, `pr`, `quota`, `backup`, `health`, `items`, `pressure` | What the job is. |
| `enabled` | boolean | `true` | | Off keeps the job but never runs it. |
| `dry_run` | boolean | `false` | | Trial mode: command jobs run with `CATALY_DRY=1`, and the job keeps its state apart from live runs; that trial state is discarded when `dry_run` is turned off. |
| `timeout` | duration | `"30s"` for command jobs; per kind below for owner jobs | 1s–24h | Time limit of a run, or of one tick. |
| `destinations` | list of strings | `[]` | names of `[destinations.*]`, or `log` | Where the job's events go. |
| `templates` | table | built-in wording | keys: event names of this job; values: text with `{field}` slots (`{{` / `}}` for literal braces) | Your own wording per event. |

Command jobs (`cron`, `once`, `probe`) also run with `CATALY_JOB=<name>` set.

### Command jobs

| Kind | Keys | Allowed |
|---|---|---|
| all three | `argv` (**required**), `cwd` (**required**) | `argv`: non-empty list of non-empty strings, no shell; `cwd`: absolute path |
| `cron` | `cron` (**required**), `zone` (**required**) | five-field cron with month and weekday names, lists, ranges, steps (`?` is not supported); an IANA zone. A local time skipped by daylight saving does not fire; a repeated one fires once. An expression that never fires is refused. |
| `once` | `at` (**required**) | an instant with seconds and offset, such as `2026-12-01T09:00:00Z` |
| `probe` | `every` (**required**), `fire`, `skip_identical` | `every`: 30s–24h; `fire`: `change` (default: on the first success after a failure) or `every` (each success); `skip_identical`: boolean, default `false` |

Events: `cron` and `once` emit `run.done`, `run.skipped`, `run.broken`; `probe` emits
`probe.fired`, `probe.error`, `probe.recovered`, `run.broken`.

| Event | Template fields |
|---|---|
| `run.done` | `job`, `outcome`, `exit`, `signal`, `timed_out`, `bytes`, `log`, `scheduled` |
| `run.skipped` | `job`, `count`, `reason` |
| `run.broken` | `job`, `run`, `started` |
| `probe.fired` | `job`, `bytes`, `log`, `scheduled` |
| `probe.error` | `job`, `reason`, `run`, `log` |
| `probe.recovered` | `job`, `errors` |

```toml
[jobs.nightly]
kind = "cron"
cron = "0 3 * * *"
zone = "Europe/Berlin"
argv = ["/home/me/bin/nightly.sh"]
cwd = "/home/me"
timeout = "10m"
destinations = ["phone", "log"]        # "phone" from the [destinations.phone] example above
templates = { "run.done" = "{job} finished: {outcome}" }
```

### Owner jobs

Built-in kinds. Each ticks every `every`, the first tick when the job is registered. All of them
emit `job.failed` (fields `job`, `reason`) and `job.recovered` (`job`, `failures`) besides their
own events.

| Kind | `every` default | `every` minimum | `timeout` default |
|---|---|---|---|
| `github` | 3m | 1m | 3m |
| `pr` | 3m | 1m | 3m |
| `quota` | 5m | 2m | 30s |
| `backup` | 30m | 5m | 10m |
| `health` | 2m | 1m | 60s |
| `items` | 30m | 5m | 60s |
| `pressure` | 60s | 30s | 30s |

The maximum `every` is 24h for all.

#### `github`: watch repositories

Discovers the newest pull requests of watched repositories and authors through `gh`, follows them,
and reports participating notifications (mention, team mention, review requested) once each.
Your own activity is never reported as someone else's.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `repos` | list of tables | **required** | each `{ repo = "owner/name", authors = [...] }`; `repo` required (letters, digits, `-`, `_`, `.`), `authors` optional logins | Repositories to watch, optionally only PRs by these authors. |
| `notifications` | boolean | `true` | | Report participating notifications for watched repositories. |
| `gh` | string | `"gh"` | | The `gh` executable. |
| `login` | string | read once from `gh` | | Your GitHub login. |
| `bots` | list of strings | `[]` | | Bot logins that count as you. |
| `emails` | list of strings | `[]` | | Commit emails that count as you. |

Events: `github.pr` (`repo`, `number`, `title`, `state`, `author`, `url`),
`github.notification` (`repo`, `reason`, `title`, `kind`), and the `pr.*` events below.

#### `pr`: follow named pull requests

Follows the PRs you add with `cataly pr follow`: new feedback from someone else, newly failed checks,
pushes, merge, close and reopen. Keys: `gh`, `login`, `bots`, `emails` as for `github`.

Events: `pr.baseline` (`pr`, `title`, `state`), `pr.feedback` (`pr`, `author`, `what`, `excerpt`,
`url`), `pr.check_failed` (`pr`, `check`, `conclusion`, `head`), `pr.pushed` (`pr`, `authors`,
`count`, `old`, `new`, `rewritten`), `pr.merged` (`pr`, `commit`), `pr.closed` (`pr`),
`pr.reopened` (`pr`).

#### `quota`: provider quota and the quota gate

Warns once when a provider limit rises past an alert level. While a watched limit is at or above
`hold`, the quota gate holds new session starts on that limit's provider; a session whose model
(`provider/id`) belongs to another provider starts as usual. Only new sessions wait: resuming an
existing session (the lead's last session after a hub restart, `cataly update`, `cataly rollback`
or `cataly lead start`, and parked or live lanes) goes ahead. A fresh lead (`cataly lead start
--fresh`, or a first lead with no session yet) and new lanes wait; `cataly lead status`, the ops
panel and the update message then name the provider, the limits with their reset times and
`cataly quota lift`. The gate opens when fresh data shows the limits below, or when every limit
that closed it has passed its reset time. `cataly status` and `cataly quota` name the held
providers; `cataly quota lift` opens the gate by hand.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `providers` | list of strings | `[]` (all OMP reports) | | Providers watched. |
| `levels` | list of integers | `[70, 85, 95]` | 1–100, at least one; sorted, duplicates dropped | Alert levels in per cent. |
| `hold` | integer | `85` | 1–100 | The gate holds a provider's new sessions from this level. |

Events: `quota.level` (`limit`, `provider`, `account`, `percent`, `window`, `reset_in`),
`quota.recovered` (`limit`, `provider`, `account`, `percent`), `quota.hold` (`limits`, `level`),
`quota.released` (`reason`).

#### `backup`: commit and push a folder

Stages every change in a git working tree, scans it for secrets (built-in token shapes and your
patterns) and for files over the size limit, and only then commits and pushes. Never force-pushes,
rewrites history or pulls. A refusal commits nothing and names files and rule, never the matched
text. The config file and `secrets/` inside the tree are refused unless git ignores them.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `dir` | string | **required** | absolute path | The working tree. |
| `name` | string | **required** | | Commit author name. |
| `email` | string | **required** | | Commit author email. |
| `remote` | string | `"origin"` | | Remote pushed to. |
| `branch` | string | `"main"` | | Branch pushed to. |
| `patterns` | list of strings | `[]` | regular expressions | Your secret patterns. |
| `max_file_mib` | integer | `50` | 1–4096 | Largest file committed, in MiB. |
| `include_cataly` | boolean | `false` | | Before each tick, copy the config file and a consistent store snapshot into the tree (the home backup). |

Events: `backup.refused` (`files`, `rule`), `backup.clean` (`commit`),
`backup.push_failed` (`reason`).

##### Home backup

`cataly setup` backs up the state folder to a private GitHub repository when `gh` is logged in, by
default `<your gh login>/cataly-home` (`--backup-repo owner/name` picks another; `--backup off`
leaves it out, and when no backup exists yet setup remembers that as `[setup] backup = false`, so a
later plain run does not offer it again until `--backup on`). It reads your `gh` login and the repository; a public repository is refused, and a
missing one is created private once you say yes. Setup makes the state folder a git working tree whose
`.gitignore` keeps token files, secrets, keys and the live database out, sets the remote, and adds
`[jobs.home]` with `kind = "backup"`, `dir` = the state folder, `remote = "origin"`,
`branch = "main"`, your GitHub name and no-reply email, and `include_cataly = true`.

#### `health`: report problems

Runs the same checks as `cataly health` and reports a warning only after `strikes` consecutive bad
ticks, then its clearing once. Checks in `[health] ignore` are skipped.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `strikes` | integer | `2` | 1–5 | Consecutive bad ticks before a problem is reported. |
| `files` | list of tables | `[]` | each `{ path = "<absolute>", max_age = "12h" }`; `max_age` 1m–8760h, default 12h | Files that must have changed within `max_age` (check `file.<path>`). |

Events: `health.problem` (`check`, `detail`), `health.cleared` (`check`).

#### `items`: new items from a command (mail watch)

Runs your command each tick. It prints one item per line: an identity, a tab, a title (at most 100
lines, 64 KiB). Each identity not seen before is reported once; the first tick only records what is
there. The command runs at most 60 s and never longer than `timeout`.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `argv` | list of strings | **required** | non-empty, no shell | The command, such as a mail search. |
| `cwd` | string | `"/"` | absolute path | Its working folder. |

Events: `items.new` (`job`, `id`, `title`).

#### `pressure`: host load, memory and disk

Samples the host. Any failing check holds new session starts, and an unknown value always holds.
Tells the lead once when the host has failed a check for five minutes in a row (alert) and once
when it clears, and once when it becomes ready for heavy compute and once when it is busy again.
Once in a state, the load must cross back 10 percentage points past the line before the state
changes again (ready below `ready_load`, busy again at `ready_load` + 10; in alert above
`alert_load`, clear at or below `alert_load` − 10), so a load near a line does not flip it every
tick. Without a pressure job, session starts use the same rule with the defaults below.
`alert_load` must be greater than `ready_load`.

| Key | Type | Default | Allowed | What it does |
|---|---|---|---|---|
| `alert_load` | integer | `150` | 1–10000 | Load per core, in per cent, above which the host is in alert. |
| `ready_load` | integer | `80` | 1–10000 | Load per core below which heavy compute is welcome. |
| `min_free_memory` | integer | `20` | 0–100 | Free memory (and container headroom) share, in per cent, below which starts wait. |
| `min_free_disk_gb` | integer | `50` | 0–1000000 | Free disk in GB below which starts wait. |
| `disk_path` | string | your home folder | absolute path | File system checked for disk space. |
| `max_sessions` | integer | `20` | 0–1000; `0` = off | Live sessions, the lead's included, at or above this hold lane starts. |

Events: `pressure.alert` (`reasons`), `pressure.clear`, `pressure.ready` (`load`),
`pressure.busy` (`load`).

```toml
[jobs.host]
kind = "pressure"
min_free_disk_gb = 20
max_sessions = 6
```
