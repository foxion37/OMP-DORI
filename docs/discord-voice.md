# Discord voice assistant (opt-in)

`dori voice discord` joins one Discord voice channel and talks with the owner through OpenAI's paid Live API (`/v1/live/sessions`, not the Realtime API). It reads lane and report status, answers information questions with web search, leaves notes in a text channel and forwards work requests to the lead session. It is off by default: installation, boot, text intake and the Discord monitors never start it or load its native codecs.

Every voice session costs money. Read [Costs and limits](#costs-and-limits) before enabling it.

## What it reuses

Voice has no separate configuration file, token or state root.

- Configuration: the optional `voice` object in the existing Dori config, `~/.dori/config.json` by default, or the path in `DORI_CONFIG`. Managed primary and side wrappers preserve their selected `DORI_HOME` and `DORI_CONFIG`.
- Discord: the existing bot token in `DORI_DISCORD_TOKEN` and the human owner's user ID in `DORI_DISCORD_OWNER_ID`. Only that owner is listened to; using the bot's own ID as the owner is refused.
- Provider key: an environment variable, `OPENAI_API_KEY` unless `voice.apiKeyEnv` names another. Keys are never read from the config file.
- Lead: the configured `leadPane` receives forwarded requests.
- State: `<stateDir>/voice/`, holding the usage ledger, the lead-reply ledger and its offset, and a single-owner lock. A second `dori voice discord` on the same state directory refuses to start.

## Configuration

`voice.enabled` must be `true`; otherwise the command exits. There is no implicit model, channel, voice or price. These fields are required:

| Field | Meaning |
| --- | --- |
| `channelId` | Discord voice channel ID to join |
| `textChannelId` | Discord text channel for notes, notices and summaries |
| `liveModel` | Model supported by OpenAI Live |
| `backendModel` | Model that runs tools and web search |
| `summaryModel` | Model that writes the end-of-session summary |
| `voice` | Voice supported by the selected Live model |
| `prices` | Per-million-token USD prices for `backendModel` and `summaryModel`, each with `input`, `cached`, `cacheWrite` and `output` |

Optional fields and their defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `OPENAI_API_KEY` | Environment variable holding the provider key |
| `backendReasoning` | `low` | Backend reasoning effort |
| `instructions` | `""` | Conversation preferences; they cannot override delivery or authorization rules |
| `timeZone` | `UTC` | IANA zone for daily limits and the backend clock |
| `dailyMinuteCap` | `30` | Live minutes per day; must be positive |
| `totalMinuteCap` | `0` | Cumulative Live minutes; `0` disables this limit |
| `backendUsdCap` | `3` | Cumulative estimated backend and summary spending in USD |
| `idleCloseSec` | `120` | Seconds of silence before a session closes |
| `wakeRmsDbfs` | `-45` | Speech level that wakes a closed session, between -120 and 0 |
| `webSearchUsdPerCall` | — | Estimated USD charged per web search; required, may be `0` |

A valid starting configuration keeps voice disabled while you enter your actual channel IDs, available models, voice and current prices:

```json
{
  "voice": {
    "enabled": false,
    "timeZone": "UTC",
    "idleCloseSec": 120,
    "dailyMinuteCap": 30,
    "totalMinuteCap": 0,
    "backendUsdCap": 3
  }
}
```

Add the required fields above and `webSearchUsdPerCall` before changing `enabled` to `true`. In `prices`, use the exact backend and summary model names as keys; each value must contain `input`, `cached`, `cacheWrite` and `output` in USD per million tokens. Obtain current rates from your provider. Zero rates disable accounting for those components and make the spending cap ineffective. The command refuses incomplete enabled configurations.

## Discord setup

The bot connects with the `Guilds` and `GuildVoiceStates` Gateway intents; these are not privileged. Voice does not need Message Content Intent.

Grant the bot:

- in the voice channel: **View Channel**, **Connect** and **Speak**;
- in the text channel: **View Channel** and **Send Messages**.

Discord voice is end-to-end encrypted with DAVE. Receiving requires its decryptor as well as Opus.

## Native dependencies

The skill package lists `@discordjs/voice` and `@discordjs/opus` as optional dependencies. DAVE comes from the version of `@snazzah/davey` required by `@discordjs/voice`; no unused second DAVE version is installed. They load only when `dori voice discord` connects. Native Opus and DAVE need compatible platform binaries. This is a source feature, not a claim that the frozen v0.1.2 release contains voice.

Review the native packages and their install scripts before installation. Bun may run scripts from its default trusted list. From the skill's `scripts` directory, install frozen dependencies and explicitly run the Opus installer with the same Bun runtime that runs Dori:

```sh
bun install --frozen-lockfile
bun --bun run --cwd node_modules/@discordjs/opus install
```

The second command matters when Node.js and Bun report different Node ABI versions: an install run by `node` can put the binary in a directory Bun will not load. It downloads the matching prebuilt Opus binary or builds it, which requires a native build toolchain. The DAVE package uses platform-specific binary packages, not the Opus install script. If either native package is missing or fails to load, voice exits with the error; text features are unaffected. Codec and DAVE support depend on your platform and Discord's current protocol. An offline Linux arm64/Bun 1.4.4 smoke test loaded Opus 0.11.0 and DAVE 0.1.12 and round-tripped one PCM frame; it did not connect to Discord or OpenAI.

## Running

Export the token, owner ID and provider key in the shell that runs it, then:

```sh
dori voice discord
```

It runs in the foreground until stopped. A service is optional; see [Running as a user service](#running-as-a-user-service).

### Sessions

- When the owner joins the voice channel, a session opens and greets them. When the owner leaves, the session closes.
- After `idleCloseSec` (2 minutes by default) of silence with no backend work pending, the session closes. Speaking above `wakeRmsDbfs` opens a new one; the last 2.5 seconds of audio before the wake are sent with it, so the first words are kept.
- Speaking over the assistant stops its playback. A discarded lead-reply chunk is not consumed; it is offered again at a later pause or session.
- A short voice-link interruption mutes output and invalidates queued reply audio without closing the owner's Live session. A disconnect lasting 5 seconds ends that session and rejoins 3 seconds later; all initial and SDK-internal recovery paths have a 30-second readiness deadline. Moving the bot to a different channel stops the bridge rather than playing the owner's answer there.
- Losing the Discord Gateway suspends voice and discards queued PCM and staged Opus packets. On resume, voice applies replayed channel changes before admitting speech again. After a fresh Gateway session, a guild voice-state snapshot can revalidate both the owner and the bot.
- New session admission is blocked until the previous session has finished provider accounting and summary delivery. If the owner rejoins during finalization, they can speak after it settles to wake a session; that rejoin does not queue an automatic greeting. On a Live, delegated Responses or summary provider failure (including a backend with no progress for 120 seconds), voice is held and a notice is posted. It never retries a paid call automatically; restart it explicitly.
- Running delegations, hosted searches and tool continuations prevent idle closure. Completed backend work gets the existing 10-second answer window before idle closure can resume.
- If input backs up past three seconds of pending PCM or playback past five seconds, voice discards the interrupted playback, leaves unfinished lead replies pending, and holds until an explicit restart. Reply offsets require the player to pull all queued speech in the current playback generation, including any final padded frame. That does not prove the listener heard it.

The [Live delegation API](https://developers.openai.com/api/docs/guides/live-delegation) can leave a session open after `responses_validation_failed`. Dori deliberately closes and holds voice on this configuration/provider rejection rather than changing delegation settings or retrying paid work. Correct the configuration before an explicit restart.

### Tools

The backend has exactly these tools; none runs a shell or executes work.

- `web_search` for information questions.
- `get_status` reads `lanes` and `reports` only, with the freshness of each source.
- `post_note` writes to `textChannelId`.
- `forward_to_lead` relays a work request to the lead.

Quick part first offers verified status while independent lead work is pending, at a natural speech pause. A partial update never means the work or relay completed; the backend still returns all requested facts.

### Risky work

Voice tools do not directly deploy, delete, pay or change production. Every forwarded message instructs the lead that a voice request is not approval for risky work and that the owner must confirm in writing. This is a prompt/operating policy, not an effect-point permission check: the `risky` field is a label, and downstream execution does not mechanically enforce voice provenance or written approval. The lead and its execution tools remain responsible for obtaining and checking the required authorization.

### Delivery to the lead

Each request gets its own ID and is sent once. Before sending, Dori checks that a live OMP lead process exists with an empty input and no pending approval or question; otherwise the request is held and reported, with no background retry. After sending, confirmation requires the same process and session plus a new user record containing that request's ID. A lead becoming active without that receipt is not confirmation. An unconfirmed or failed send is reported as such and is never resent.

Before the backend result, the assistant may say it is passing the request on, not that it has passed it. Not-sent, held, queued or failed results must remain negative, even if mixed with success wording or `ok:true`. A sent-but-unconfirmed result stays unconfirmed. Only receipt for this request permits a completed-relay claim; quick facts do not. Mention retries only if the result says they are scheduled (this implementation schedules none), and correct an earlier premature claim. Forwarding is not completion.

These Live and backend prompt rules are not deterministic enforcement of model speech. Offline tests check their presence and the tool states, not every spoken paraphrase or promise. No paid end-to-end Live/Discord test is implied by the offline suite.

### Lead replies

The forwarded message asks the lead to append replies to `<stateDir>/voice/lead-replies.jsonl`, one JSON object per line: `{"at": "<ISO time>", "re": "<short summary of the request>", "text": "<reply>"}`. The assistant relays them at a natural pause. A long reply is split into pieces of at most 500 UTF-8 bytes, and each piece needs acknowledgement, output transcription of at least 30% of its non-whitespace characters (at least 8 unless the piece is shorter), and completed playback before the next. This length-based transcription check is not a semantic proof that the model said the correct reply. A reply line is consumed only after its last piece meets that check and finishes playing; the model's acknowledgement alone does not consume it. If the owner leaves midway, the next session reads that reply again from the beginning. Unconsumed replies wait for the next session.

## Privacy

Recordings and transcripts are not written to disk. Audio and transcripts go to the provider. When a session ends, a short summary and the tool outcomes are posted to the text channel; tool results may include lane and report content. Logs do not contain audio or full Gateway payloads.

## Costs and limits

- Live speech is billed for the whole open session, including silence. Joining the channel opens a session.
- Web search and backend/summary calls are billed separately.
- Daily Live time is capped at `dailyMinuteCap` (30 minutes by default) in `timeZone`; `totalMinuteCap` caps cumulative time and is off at `0`. Estimated backend and summary spending is capped at `backendUsdCap` ($3 by default), cumulatively.
- At a limit, voice does not start and posts one notice per day. The ledger is `<stateDir>/voice/usage.json`; a corrupt ledger stops voice rather than resetting.
- Backend spending is estimated from your configured prices and per-search value, not from provider billing. Usage already in flight when a limit is reached is still billed, so actual charges can exceed a cap. Use provider-side spending limits as well.

## DAVE and audio limits

After MLS initialization, commits, welcomes or transitions, Dori opens a finite 30-second window accepting unencrypted owner frames as well as encrypted frames. Outside the window unencrypted frames are dropped; encrypted frames are always decrypted. Discord transport encryption remains in use during this end-to-end-encryption tradeoff. Corrupt frames are dropped and counted; closed owner streams are resubscribed. Audio quality and latency depend on network, provider and platform codec support; this guide makes no latency claim.

## Running as a user service

[`examples/discord-voice.service`](../examples/discord-voice.service) is a systemd user unit example. Nothing installs or enables it. To use it, adjust the paths, provide an environment file with mode `0600` holding `DORI_DISCORD_TOKEN`, `DORI_DISCORD_OWNER_ID` and the provider key, then copy it to `~/.config/systemd/user/` and enable it yourself. A running service spends money whenever the owner joins the channel.
