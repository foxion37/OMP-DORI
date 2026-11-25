# Public releases and support

## Cataly is a new product: moving from omp-dori

Cataly is a new product, not an upgrade of omp-dori. This version removes every omp-dori name, the herdr and hc terminal runtimes and the omp-ulw overlay. There is no in-place upgrade of omp-dori code, and no rollback to it.

The installer does the move. It imports the config, messenger tokens and owner profile of a previous `~/.dori`, `~/.omp-dori`, `DORI_HOME` or `OMP_DORI_HOME` installation into the new home in the current format, validated by the current loader, and never overwrites a setting the new home already has. It then deletes that home once the import verifies and nothing of it still runs, and removes the links, commands and caches the previous version left behind; a home still in use is kept and the next install retries. A `~/.cataly` that an earlier version installed from source is converted in place.

Old lanes are not resumed. Finish or close the lanes you care about before installing (`cataly status` lists them), then start with `cataly harness up` and open new lanes.

The ULW commands and skills are no longer installed. OMP's own `goal` tool and any skills you install yourself remain available.

## Current source bundle

Current source and releases declaring a verified headless profile use a bound OMP toolchain. Cataly runs on headless OMP by default on macOS and Linux; the optional [Tern](runtime.md#tern) terminal runtime is a source feature outside the consumer release path. Install git and Bun 1.4.4+. Every installation also needs the native Cataly binary: releases bundle it for Linux x64 and macOS arm64, and source installation builds it with Cargo, so install a Rust toolchain with [rustup](https://rustup.rs) before installing from source; on macOS the build also needs the Xcode Command Line Tools (`xcode-select --install`), whose libclang and SDK generate its `libproc` bindings. You do not need a terminal server, a stock `omp` on `PATH`, provider credentials or global native-cache changes to prepare it. Authentication is a separate step before starting an agent.

`native-omp.lock` and `native-omp.patch` bind upstream [oh-my-pi](https://github.com/can1357/oh-my-pi) commit `f40f335845f0b136453d12fec8d6057011082766` (19.0.1), the patch SHA-256, resulting Git tree and modified-file SHA-256/modes. The home-local cache is `~/.cache/omp-cataly/native-<platform>-<arch>-<full-source-identity>`. Preparation installs frozen upstream dependencies and the separately frozen official `@oh-my-pi/pi-natives@19.0.1` package from `native-addon/`. It probes the actual addon and copies those version-matched bytes through the existing workspace loader seam; receipts bind the actual addon, Bun and launcher bytes. Rust is unchanged. The addon release stamp establishes its release compatibility, **not** the source delta or binary equivalence to a rebuilt OMP executable.


Bun and addon SHA-256 checks read every byte through a fixed 1 MiB buffer, both when creating a receipt and when revalidating it. Hashing remains synchronous and serial; no timestamp cache or skipped integrity check is used.

The default command remains literally named `omp`. It validates the bound source, then executes upstream `packages/coding-agent/scripts/omp` through the recorded Bun, retaining that launcher's empty-cwd/preload protection. Every tracked source file and the expected overlay index tree are independently checked; a stock 19.0.1 image, version-only receipt, unchanged launcher hash, malformed patch or partial cache cannot satisfy this bundle. Drift holds installation/reuse/launch instead of fetching around it or falling back to stock.

Primary source sessions use `~/.cataly/bin/omp`; side sessions use `omp-cataly omp`. Both generated `agentCommand` defaults use their guarded source wrapper. Consumer releases provide their own `<home>/bin/omp` and resolve their frozen wrapper on update and rollback without rewriting existing config bytes; already loaded release code stays pinned to its own release, including its isolated discovery overlay. Managed deployment omits `promotion.deployment.omp` for the source default, prepares the bound native bundle before admission and retains its identity in toolchain receipts.

Explicit overrides remain advanced contracts: `CATALY_OMP` for source installation, an absolute custom `agentCommand` or `promotion.deployment.omp` select user-owned code. A managed external native receipt is marked `nativeOverride`, never presented as patched-source proof. Preserve these explicit choices when reinstalling; a custom native override is not evidence for the complete bundled default.

See the [OMP 19 port and per-hunk audit](native-omp-19.md) and [automatic native candidate workflow](native-omp-updates.md). Stable 19.x manifests use the same authenticated bound-source protocol; a future native major requires review.

## Support boundary

Current releases install only headless profiles for Linux x64 or macOS arm64, declared by the release's bound `release-headless.json`. Slack and Telegram remain source features. The maintainer source-container recipe is separate from the public release installer; it is not a published consumer image.

Releases published before the Cataly rename use the omp-dori release format. This controller does not install, update or roll back to them; see [moving from omp-dori](#cataly-is-a-new-product-moving-from-omp-dori). The immutable `v0.1.0` and `v0.1.1` tags are superseded unpublished release attempts with zero release assets, not stable published releases. See the [release history](../CHANGELOG.md#superseded-unpublished-tags) for the draft-identity and first-upload failures.

Linux x64 identifies the platform and architecture, not a tested matrix of Linux distributions. Qualify the specific distribution and toolchain against the release's actual clean-consumer evidence; other Linux distributions remain compatibility targets with unverified consumer behavior.

Release support does not imply an independent external-user beta, exhaustive provider testing or universal compatibility. Exact-head CI, isolated install/recovery checks, native runtime behavior and real messenger intake/reply are distinct evidence. Check the evidence attached to the particular release before treating any of those as exercised. This guide describes the contract and operating procedure; it is not a test-run receipt.

## Prerequisites and trust

Install git and Bun 1.4.4+ yourself and put their binaries on `PATH`; [Bun](https://bun.sh) documents its own installation. The verification example below uses Bash and `sha256sum` (or `shasum` on macOS).

Consumers need neither the GitHub CLI nor GitHub write permission to install, check, update or roll back Cataly. These operations do not call porting/review models or change global provider settings. Later AI sessions use your own configured provider and quota; Discord uses your own application/bot account and token. No maintainer credentials, private session history or model authentication ship in the assets.

Use the canonical repository **https://github.com/vntrevx/Cataly**. Confirm the exact tag, repository owner and release commit before downloading. Do not substitute a fork, an arbitrary `main` script or an unverified mirror.

Each release has four matching assets.

| Asset                      | Purpose                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `cataly-v<version>.tar.gz` | Public source archive, rooted at `cataly-<version>/`                                                      |
| `release-manifest.json`    | Product/version/tag, commit/tree, archive digest/size, public source manifest and the required OMP version |
| `SHA256SUMS`               | SHA-256 checksums for the release payload files                                                           |
| `install.sh`               | Release bootstrap, separate from the source-checkout installer                                            |

Current release archives also contain the native Cataly binary at `native-bin/linux-x64/cataly` and `native-bin/darwin-arm64/cataly`. Both are executable entries of the public source manifest, so their SHA-256 digests are bound like every other release file.

Checksums establish consistency with the files downloaded from that trusted release. They are not an independent signature or a substitute for verifying the publishing repository. The installer also validates the manifest bindings, archive digest and extracted source manifest. Tar entries are checked before extraction; links, special files and unsafe paths are not admitted.

## Install a current release

Use a verified asset set from a release that declares a headless capability for
Linux x64 or macOS arm64. `release-headless.json` is bound by the source manifest
alongside the bound OMP payload. Check the release’s exact tag and checksums
before running its own bootstrap; an unbuilt or unpublished `main` is not a
consumer release. Run the following from the directory containing the matching
assets:

```sh
download_dir="$(pwd -P)" || exit 1
if command -v sha256sum >/dev/null; then
  sha256sum --check SHA256SUMS || exit 1
else
  shasum -a 256 --check SHA256SUMS || exit 1
fi
bash ./install.sh --from "$download_dir"
# Linux x64:
"$HOME/.cataly/bin/cataly" harness status
# macOS arm64 (isolated default):
"$HOME/.omp-cataly/bin/cataly" harness status
```

`harness status` reports `RUNTIME headless (from default)`.
`cataly harness up` is a separate, explicit start of native OMP lead and duty
sessions and their local scheduling loops. Installation itself starts nothing.

Only run the installer after every checksum passes. With that checked installer, `bash ./install.sh --version vX.Y.Z` or `CATALY_RELEASE=vX.Y.Z bash ./install.sh` fetches the exact network release instead. A request without an explicit version selects a stable release only; it does not silently opt into a prerelease.

`--from DIRECTORY` is a supported local release-asset input for the bootstrap and for consumer `check`/`install`. Copy the four matching assets together. It is **not** a completely air-gapped first-install promise: git may still need anonymous network access to obtain the exact bound native OMP source. A previously prepared native cache is reused only after validation. There is no separate opaque dependency bundle format.

## Installation homes

A fresh installation defaults to `~/.cataly` (Linux primary) or `~/.omp-cataly` (macOS side). `--home` selects an absolute home; `CATALY_INSTALL_MODE=side` and `OMP_CATALY_HOME` select a separate side installation when not using `--home`. An installed update command defaults to its loaded installation. Release selection does not rewrite an existing config.

The isolated home contains `bin/cataly`, `bin/cataly-harness`, `bin/omp`, `bin/omp-cataly` and `omp.yml`. Its renamed `omp-cataly-mode` skill and discovery overlay are retained per release under `releases/consumer-discovery/<release-id>/`. The wrapper resolves the active source pointer before selecting both the extension and that release's skill, so a held or interrupted activation cannot mix their versions. Use local paths such as `"$HOME/.omp-cataly/bin/omp-cataly" omp --cataly-role cataly`; the wrapper loads only the local Cataly extension, with `--no-extensions`. It binds the selected config, clears inherited state/runtime overrides, and defaults state inside that home while preserving an explicitly configured state directory. There are no global command, skill or extension links and no global discovery of this installation. Configure the local home and authenticate deliberately before launching; installation itself launches nothing.

This controller reads only Cataly release manifests (schema version 2, product `cataly`); it rejects the manifests of releases published before the Cataly rename.

Explicit install, reinstall and rollback refresh unchanged owned launchers to the running Bun. Releases retain their authenticated native source/addon/Bun receipts; a changed native toolchain holds rather than accepting stock OMP or rewriting those receipts. The isolated OMP dispatcher resolves the active source pointer and launches that release's own guarded `scripts/consumer/omp`, extension and discovery together, including during interrupted activation. Owner-modified launchers remain held. A bound native cache requires its recorded Bun identity; preserve that executable and use it for recovery. Do not hand-edit wrappers or use the source installer to take over a consumer home.

To migrate from source, first install into a separate fresh release home and preserve the source installation untouched. Stop the source Cataly and its monitors before any deliberate, user-authorized copying of selected configuration, state or authentication, reconfiguration and launch in the new home. Review paths and runtime settings for the new home. Never overwrite a live source home or automatically copy secrets. Source-owned homes are held rather than taken over.

## Installation layout and preserved data

The primary Linux consumer installation uses:

- `~/.cataly/bin/cataly`: the skill/operator CLI; `~/.cataly/bin/cataly-harness` is the separate harness CLI.
- `~/.cataly/src`: the single active source pointer.
- `~/.cataly/releases/releases/<commit>-<public-source-hash-prefix>`: verified retained release directories; the hash prefix has 16 hexadecimal characters.
- `~/.agents/skills/cataly-mode` and `~/.omp/agent/extensions/omp-cataly`: stable references through the active source pointer.
- `~/.cataly/config.json`: an example is created only if this file is absent.

The consumer keeps its own installed-state and activation journal under the release root, separately from maintainer managed-deployment journals. It stages and verifies a candidate before switching the source pointer and retains the previous source for rollback. Treat a release directory as frozen: edit your configuration or use a separate source checkout rather than changing installed product files.

Existing config, authentication, work records, sessions, history and explicit model choices are preserved. The installer does not copy another user's authentication or replace global model settings.

New builds support configuration-only `cataly update install --preview` with the same `--version`, `--from`, `--home` and runtime selection. It verifies the release and extracts it into disposable private storage, then removes that storage; it does not provision dependencies, create the selected installation home, reconcile its activation journal, or activate a release. Existing consumer configuration is preserved byte-for-byte. The preview reports target paths, create/preserve actions, hashes and managed key names, never configuration values. This is not a full installation or a compatibility upgrade to an older released CLI.

Both setup paths capture owned regular configuration files before preparation. An observed identity, permissions or content change holds publication/activation: retain the owner edit and rerun the preview before installing. New files use private staging and atomic no-clobber publication with mode `0600`; source setup creates a missing installation home with mode `0700` even under umask `0002`. Existing owned modes and groups are preserved, but group/world-writable files or directories and linked configuration files are held. Existing source-directory aliases remain supported: setup captures their physical configuration paths and refuses a receipt whose alias target changes. Consumer paths retain their existing no-symlink boundary. Inspect an owned target and remove its group/world write permission with `chmod go-w` before retrying; setup never changes existing permissions for you. Replacement is per-file atomic, with an optimistic comparison immediately before rename, not a linearizable compare-and-swap against an uncooperative writer. The whole installation is not a multi-file transaction: checkout, dependency or reference preparation may already have completed when a later configuration check holds. No unrelated edit is rolled back.

`SETUP_READBACK` separates saved bytes from effective configuration. It reports the actual Cataly reader's selected file and overridden key names without secret values. It compares that reader with and without field-level CATALY environment overrides, keeping the same installation home and managed release resolution; omitted defaults count too. A consumer updater whose reader cannot resolve its old configuration/toolchain reports `effective: "unavailable"`, a sanitized `reason` and `overridden: null` instead of blocking repair through install or rollback. Ownership, concurrent-edit and target-release checks still hold activation. Source setup stops when effective readback is unavailable. Primary source setup uses the installer environment; side source setup uses the generated wrapper environment. Consumer setup reads its explicitly selected file/home through the current updater reader and inherited process overrides, not a future or already-running native session. The side YAML receipt confirms saved bytes and `nativeSession: "not-started"`; it does not claim native settings were activated. No account probe, model selection activation or background process is performed by readback.

New native defaults resolve the loaded release's guarded `scripts/consumer/omp`, even if the active pointer moves. Update and rollback do not rewrite config bytes. Exact source/patch/result identities are checked before a bound native source is used; paths outside these managed shapes remain explicit user choices.

An existing real directory at `~/.cataly/src`, an unmanaged pointer, or a conflicting non-link skill/extension/launcher destination holds installation rather than overwriting it. Keep the old installation and its data intact. Continue its source-checkout workflow or plan an explicit stopped migration with backups; the first preview does not silently convert other layouts. Do not delete an existing installation to bypass a hold.

## Your authentication and explicit startup

Set `defaultCwd`, a provider-qualified `defaultModel` available to your account,
and the messenger hooks you intend to use in the selected home’s `config.json`.
Keep the installer’s managed `agentCommand`. Authenticate the selected OMP
wrapper with your own provider.

Before starting the lead, select the actual installation (`~/.cataly` for fresh
Linux primary, `~/.omp-cataly` for fresh macOS side, or the original/custom home):

```sh
export CATALY_HOME="$HOME/.cataly"  # Substitute the actual home.
```

Create and invite your bot through the [Discord Developer Portal](https://discord.com/developers/applications).
Enable **Message Content Intent** on the Bot page and grant View Channel and
Read Message History in the selected channel, plus any permissions needed to
send or manage threads. Put only the token in the owned regular file
`$CATALY_HOME/discord-token` (mode `0600`). Load it as `CATALY_DISCORD_TOKEN`
only in the opted-in messenger child; never expose it in chat, command arguments,
source, monitor specifications or support reports.

Copy your own user ID and the exact channel or thread ID using Discord Developer
Mode. These values are not secret and may be inherited by monitor children:

```sh
read -r -p "Your Discord user ID: " CATALY_DISCORD_OWNER_ID
read -r -p "Discord channel or thread ID: " CATALY_DISCORD_CHANNEL_ID
export CATALY_DISCORD_OWNER_ID CATALY_DISCORD_CHANNEL_ID
"$CATALY_HOME/bin/cataly" harness up
```

This explicitly starts the registered lead, duty and loops. Orient the lead
with “Cataly mode” and complete the name, messenger destination and permitted-tool
onboarding. For a headless lead, `cataly harness send lead --text "Cataly mode"`
submits the message and `cataly harness observe lead` reads recent output. Use
the selected home’s `bin/cataly` if it is not on `PATH`. Do not start a duplicate
against the same state.

Install, update, rollback and `cataly boot` do not start a provider, inbound
watcher, Gateway presence process, systemd service or harness. Enable only the
monitors you intend to operate. Resuming a prior OMP session can restore its
recorded monitor intent; an explicitly stopped monitor stays stopped.

### Discord owner intake

The receiver is **`cataly inbound discord [--loop MINUTES] [--gateway]`**. Required child environment is `CATALY_DISCORD_TOKEN` plus `CATALY_DISCORD_OWNER_ID` and at least one channel through `CATALY_DISCORD_CHANNEL_ID` or `CATALY_DISCORD_CHANNEL_IDS`, unless `CATALY_DISCORD_SCOPE=all` is selected. Only the configured owner's text in watched channels is emitted. Bots, the bot itself, other users, webhooks and system messages are excluded from that output. Threads configured by their own ID remain independent; active threads under configured parent channels are followed by default. `CATALY_DISCORD_THREADS=on` or unset enables this following; `off` disables it without changing scope `all`.

Gateway queue admission happens before that owner-output filter. Valid scoped `MESSAGE_CREATE` frames are stored with their full payload in the private SQLite queue, including other users', bots' and webhooks' text, attachment metadata and signed URLs. In scope `all`, this can include valid frames from channels not yet discovered by REST. Nonowner rows are discarded when drained; pending payloads survive shutdown. Private ownership and `0700`/`0600` modes restrict access, but acknowledgement/deletion makes no secure-erasure guarantee for SQLite or its journal.

A first live frame from an unknown channel waits for thread-parent scope resolution in bounded volatile memory: at most 100 frames and 1 MiB aggregate serialized payload bytes, one concurrent resolver and 256 historical lookup results. Known-scoped frames are durably queued immediately even while that lookup stalls. Transient lookup failures retry at the existing 2–30 second backoff; overflow or an oversized candidate stops intake visibly without deleting committed FIFO work. No unscoped payload is written to disk. **A crash, close or overflow can lose unresolved candidates**, including a frame since deleted from Discord; this is not the admitted full-payload recovery guarantee. Once admitted, thread rows retain their parent provenance and payload for recovery while covered by the current intake scope, even when archived, absent from listings or unavailable to metadata/history reads. Queued rows excluded by a scope change, including disabling parent following when relying on that parent, are discarded when drained rather than held for re-enabling. An unresolved native head attempt instead retains the global FIFO fence until its original receipt is reconciled or the operator explicitly abandons it; a scope change does not authorize deletion.

Additional configured channel IDs are opt-in: `CATALY_DISCORD_CHANNEL_IDS=ID,ID,...` adds channels or threads alongside the single-ID configuration (all explicit IDs must be readable, or startup fails), and `CATALY_DISCORD_SCOPE=all` additionally discovers readable guild text channels, active threads and the owner's DM with the bot. Discovered channels that return 403/404 are skipped, including an unavailable owner DM; authentication, rate-limit and server failures still propagate. The set is refreshed on every Gateway READY/RESUMED, or every 100 REST polls; followed threads are refreshed on every READY/RESUMED and every tenth REST poll, and threads the bot cannot read are skipped. Every watched channel and thread has its own cursor.

With the protected token file prepared above and the non-secret IDs inherited from the owning OMP session, explicitly start one native `monitor` using these `argv` values and filter `^INBOUND`:

```json
[
  "bash",
  "-c",
  "set -eu; base=\"${CATALY_HOME:?Select this installation home}\"; CATALY_DISCORD_TOKEN=\"$(cat \"$base/discord-token\")\"; export CATALY_DISCORD_TOKEN; exec \"$base/bin/cataly\" inbound discord"
]
```

The token value never appears in this argv or its monitor receipt: only the child shell reads and exports it. No private helper, external watch script, Node or agent-messenger is needed. A different token-file path is an explicit local choice; keep it owned, regular and mode `0600`.

To let Discord follow-ups reopen a registered lane after its session retired cleanly, add `--wake-lanes` to that existing shared REST monitor's command. Keep the same state directory, bot, owner, and watched rooms and stop any overlapping per-room poller before enabling it. No installation or update enables the flag for you. The monitor queues the message, resumes the same OMP session headlessly when its binding is verified, and posts the resulting answer to the original Discord message. Explicitly paused lanes stay paused. Hard-killed or unverified sessions, Gateway intake, and `--loop 0` are outside the automatic reopen path.

Automatic reopen waits for the new process to own the same native session. The lane uses the saved model; when its identity differs, the monitor leaves the message queued. The reopened process uses a bundled quota/retry overlay that disables model fallback, provider-error retries, and automatic saved-reset redemption. It does not edit your OMP configuration. Interrupted or rejected Discord dispatches are held without replay, and a deleted Discord original is never replaced with an unthreaded reply.

During a native OMP turn, the receiver posts a typing indicator immediately and refreshes it every eight seconds. It pauses while an approval card waits for owner input and stops when the turn finishes. This is separate from the Gateway online-presence monitor.

This path currently requires Linux to confirm native session ownership. The shared receiver must remain running while a lane is retired; it does not start if the monitor or its owning session has exited.

For a long-running receiver, optionally set `"restart": "on-failure"` in the
same monitor start request. The monitor retries a nonzero exit or signal after
five seconds, up to three times in a failure streak. A run of at least one minute
resets that streak. This option is stored with the monitor and applies when the
same session resumes. Clean exits, including successful `--loop 0`, are not
retried. Explicit stop, session shutdown, output storage failure, and uncertain
monitor delivery do not retry the child. Existing monitors with no policy keep
their current behavior. The monitor itself still belongs to the OMP session:
use the same session's resume path after OMP exits. This is receiver-process
recovery, not an end-to-end delivery acknowledgement.

By default the command polls continuously every **three seconds**. `--loop` uses **minutes**: `--loop 0.1` means six seconds, and `--loop 0` runs once. Append those flags after `inbound discord` in the opted-in argv when needed.

Startup validates bot authentication, application Message Content Intent and View Channel/Read Message History access before `INBOUND_READY discord owner=<id> channel=<id[,id...]|all> bot=<id>` (`mode=gateway` is appended with `--gateway`). Each channel without a stored cursor baselines its latest message ID without replaying history; an empty channel starts at `0`. This also applies to channels first found by a later REST discovery. In scope `all`, a channel first seen through a live dispatch starts just before that message, so earlier history in that channel is skipped. Existing stored cursors resume instead of baselining again. **Wait for readiness, then send a fresh owner message.** Subsequent owner messages appear as `INBOUND discord <channel> <message> from=owner ref=<id|-> <JSON text>` for native monitor delivery to the owning OMP session.

Attachment-only and Discord voice messages keep the text `""` on that unchanged `INBOUND discord` line. Reply context follows as `INBOUND_REPLY`; each attachment follows as `INBOUND_ATTACHMENT` with its filename, optional content type, size, exact signed URL and optional voice/duration metadata ([record format](../skills/cataly-mode/references/scripts.md#cataly-inbound-discord---loop-minutes---gateway----wake-lanes)). Reply context is data, not a new owner request. An omitted snapshot adds `"status":"unresolved"`; an unavailable target (for example, after deletion) adds `"status":"unavailable"`. Both retain `ref=` and the original reply ID, with `null` author/text rather than invented empty text. Signed URLs expire, so use them promptly for an explicitly chosen download or `cataly transcribe <url>`. Metadata delivery itself starts no transcription or inference. REST and Gateway use the same formatter and one emit per message before cursor commit; a malformed attachment/list, mismatched reply identity or throwing emitter leaves that message uncommitted.

The cursor is committed under `<stateDir>/discord-inbound/<channelId>.json` in a private owned directory with mode-0600 atomic cursor files. Later REST polls page back to the cursor, deduplicate and handle known owner messages in ID order. Explicitly restarting the monitor resumes its committed cursor. Do not delete the cursor to simulate successful intake. This is new-message intake with reply/media metadata; edit and delete events are not delivered.

Only a remote history-read 403/404 removes an unavailable discovered channel; explicitly configured targets still fail on those responses. Content conversion, delivery and local cursor failures are not permission loss. In Gateway mode they stop intake before later queued messages can advance past the failed message. If an already watched channel's cursor disappears, intake reports the missing-state error rather than silently dropping live messages or recreating a baseline. First-seen scope-all channels still seed their new cursors as described above.

An owner message to an exact Discord channel or thread registered to one
native OMP lane goes to that lane as a Cataly Monitor message, with no
keystrokes and no new setting. The receiver commits the lane inbox before
advancing its cursor; pending messages survive a resume of the same session.
Unbound or ambiguous channels keep the lead's existing intake behavior.
An exact reply to an open ASK takes precedence over ordinary chat.

To take over an independently configured receiver, stop the old reader before
starting that exact lane once with `--cataly-lane-receiver`. This uses its
existing explicit receiver state and credentials, requires a separate mailbox
and cursor root, and remembers the takeover on that session only. The normal
shared receiver requires no flag. Restart the shared receiver when upgrading
so it uses the new routing logic.

#### Answering native OMP ASK from Discord

On a supported Discord connection, ASK is enabled automatically once
`cataly inbound discord` is running and has verified the bot, owner and
channels. It prefers that installation's private `$CATALY_HOME/discord-token`.
If the file is absent and a Cataly lead already has `CATALY_DISCORD_TOKEN`, ASK
can use it only with a live receiver authenticated with the same credential.
This compatibility path does not apply to lanes. Continue to load the token
only in the receiver child for new setups. No settings file is created or edited.
Restart the receiver when updating so it reports its current routes.
Automatic routing works on Linux and macOS: the native receiver publishes its
route with its own process identity, read through procfs on Linux and libproc
on macOS, so a receiver whose PID was reused is never chosen.

Eligible single-choice questions show native Discord buttons, with the
checked option labeled **Recommended**. Only the configured owner can
select a button. The bot uses an interaction-only Gateway connection;
apps with an existing interactions webhook or unavailable Gateway keep
text replies and the native OMP dialog.

For a compatible one-field question, ordinary owner text in the exact
channel can answer while exactly one such ASK is pending. For a radio
group with **Other**, free-form text is passed to OMP as the answer,
without selecting the recommendation. Use Discord's **Reply** action
to target a specific question or when the question has multiple fields.

If a posted Discord ASK has exactly one explicitly recommended choice and
no answer after three minutes, Cataly submits that choice and marks it as
a timeout, not an owner reply. Forms without a unique recommendation stay
open. This does not change OMP's own timeout or approval settings.

- A Cataly lead uses the single explicitly configured Discord destination.
  If more than one destination is configured or only discovery is enabled,
  ASK stays in the native OMP dialog rather than guessing.
- A lane uses only its own registered `discord:<channel-or-thread-id>`
  destination while the same receiver watches it. New `cataly launch` lanes
  are bound at launch; an older lane without an exact native session identity
  in the registry stays unbound.
- Stopped receivers, unmatched bot credentials and unresolved lanes do not
  enable automatic delivery. A custom token file or receiver can still use
  the existing explicit route below.

An explicit route in `<stateDir>/discord-ask.json` takes precedence. Use an
absolute token file path, keep both files owned and mode `0600`, and make
sure the bot can post in the selected room. Set a session's entry to `false`
to keep ASK local for that session. No manual file is needed for the
standard connection above.

```json
{
  "sessions": {
    "<OMP-session-id>": {
      "channel": "<Discord-channel-or-thread-id>",
      "owner": "<Discord-owner-id>",
      "tokenFile": "/absolute/path/to/discord-token"
    }
  }
}
```

The bot first posts a short preparation message, then fills it in once it can
receive replies. Use Discord's **Reply** on the completed ASK. For a single
field, plain text can be enough; for multiple fields, submit a JSON object
using the field names in the question. When a choice lists **Other**, you
can include one custom text value. An invalid reply explains the error
without submitting the form; reply to the original ASK again. A different
room, a new message, or a reply to another question does not answer the open
form.

Local input still works and the first valid submission wins. Forms that
cannot be represented faithfully, including password and file inputs, stay
local. ASK answers do not approve tools or get queued as ordinary lane input.
An OMP session switch, cancellation, or restart ends the open question. This
feature posts question text to the configured room; do not select a public
room for a session that asks about private work.

#### Real-time Gateway mode

Add `--gateway` to receive owner messages live instead of on the next poll. The receiver keeps one Gateway connection that subscribes only to `GUILD_MESSAGES`, `DIRECT_MESSAGES` and `MESSAGE_CONTENT`; it sends no presence update. **`MESSAGE_CONTENT` is a privileged intent: enable Message Content Intent for the bot in the Developer Portal**, otherwise Discord closes the connection with code 4014 and intake stops with an error naming it. **`--gateway` ignores `--loop`, including `--loop 0`; it runs until stopped.**

After every `READY` and `RESUMED`, backfill merges older REST gaps with eligible durably queued owners before a newer delivery or filtered checkpoint. A queued request is not cancelled when REST no longer returns it. Ordering is per channel for records known before each delivery selection. An older frame admitted during an awaited newer emit can be delivered late without moving the cursor backwards.

A transient backfill failure (HTTP 429, real HTTP 5xx or an unreachable API, after the usual request retries) is retried every 2 s doubling to 30 s with `DISCORD_GATEWAY_BACKFILL_RETRY` lines while live messages wait. Locally detected malformed responses, channel mismatches and non-advancing pagination stop intake with a sanitized error; they are not transient server responses. Failed delivery, cursor persistence, exact acknowledgement or a terminal close also exits nonzero. Gateway progress uses `DISCORD_GATEWAY_READY`, `DISCORD_GATEWAY_RECONNECT` and `DISCORD_GATEWAY_STOPPED` lines, outside the `^INBOUND` filter; they contain no message text.

Gateway shutdown stops connection/retry scheduling and retains pending work in the private `<stateDir>/discord-inbound/gateway.sqlite` queue. It drains active backfill reconciliation, including merged deliveries and cursor commits, before finishing; it does not cancel an in-flight HTTP request. Restart reads older REST gaps before a retained message prefix and preserves queued scope-all channels. A genuinely new queued channel seeds just before its lowest known queued ID, without replaying earlier cold history.

The SQLite page-cache budget is 256 KiB, memory mapping is disabled, and the database is capped at 256 MiB plus journal overhead. Admission metadata and indexes consume that budget; initial index construction also requires disk I/O and temporary space. Disk storage replaces unbounded application backlog retention. WAL `synchronous=NORMAL` preserves process-crash recovery; power-loss recovery still uses durable REST cursors. Storage exhaustion stops intake with committed pending work intact. One intake owns each state directory; REST mode refuses to start while Gateway work is pending. Restart with `--gateway` to drain it.

Admission metadata is not a delivery receipt. An emit/checkpoint crash can repeat a request, as can a crash after late emission but before exact acknowledgement. Pending owners queued without an admission position replay conservatively below the cursor and may repeat an already delivered request. Ordinary stale frames admitted after a completed cursor commit still deduplicate. See the [queue lifecycle and recovery boundaries](../skills/cataly-mode/references/scripts.md#cataly-inbound-discord---loop-minutes---gateway----wake-lanes).

To select Gateway delivery in the monitor recipe above, append `--gateway` after `inbound discord` in its argv. It is opt-in; installation and updates select neither Gateway intake nor scope `all`. Intake and `cataly presence discord` use separate Gateway sessions even with the same bot token; sharing the connection implementation does not share their session or lifecycle.

Former maintainer tooling `bun scripts/bench-discord-intake.ts` (removed with the TypeScript intake) compared the immutable pre-Gateway `f5d34ab98ad040a500689fbeefe507e54281eff3` intake with single/multi-channel REST and Gateway variants. It requires that Git object in a source checkout. `--base REF` selects another commit with the earlier single-channel intake API. This is an **OFFLINE synthetic benchmark** against loopback HTTP/WebSocket stand-ins, with synthetic IDs and no Discord credentials or external Discord requests; its output measures local intake logic, not real Discord service latency.

Startup auth, permission, intent and state errors exit nonzero with sanitized output. Later poll failures produce `WARN` and retry on the polling loop. Inspect those errors and actual fresh owner delivery before claiming setup works; readiness alone is not an intake/reply receipt. SIGINT/SIGTERM stops REST intake. It does not set online presence, and stopping it does not stop the separately enabled Gateway presence monitor.

### Discord online presence

Discord REST inbound polling and message sending alone do not keep a bot online. For an online indicator while Cataly is in use, explicitly run **`cataly presence discord`** under the owning OMP session's native **`monitor`** supervision. Supply `CATALY_DISCORD_TOKEN` only in that child's environment. Keep the presence command running alongside the separately enabled native `cataly inbound discord` monitor; neither replaces the other.

For an explicitly enabled presence monitor, use these native monitor `argv` values and filter `^PRESENCE_`. The protected token file is read inside the child shell; the monitor specification contains only its path, never the token:

```json
[
  "bash",
  "-c",
  "set -eu; base=\"${CATALY_HOME:?Select this installation home}\"; CATALY_DISCORD_TOKEN=\"$(cat \"$base/discord-token\")\"; export CATALY_DISCORD_TOKEN; exec \"$base/bin/cataly\" presence discord"
]
```

Presence logs distinguish actual Gateway state:

- `PRESENCE_READY discord event=READY` or `event=RESUMED` follows that genuine Gateway dispatch, not merely opening a socket.
- `PRESENCE_ACK discord seq=<number|->` records only the first actual heartbeat acknowledgement of each connection; later routine acknowledgements update lifecycle state silently.
- `PRESENCE_RECONNECT discord reason=... code=... retry_in=...s` describes reconnecting, not readiness.
- `PRESENCE_STOPPED discord` records an explicit SIGINT/SIGTERM stop; sockets, timers and retries are stopped and the bot goes offline.

An authentication, configuration or intent failure exits nonzero with a sanitized Gateway error. Inspect that error and your bot setup; do not treat successful REST sends as evidence of presence. Intentionally stopping the native presence monitor means the bot should go offline. Restart that monitor only when you explicitly want presence again. Do not restore unrelated paused watchers or the maintainer updater to fix an offline indicator.

## Updates and rollback

The consumer API runs before ordinary Cataly configuration loading. Use the selected home’s `bin/cataly`, especially for an isolated or upgraded installation:

```text
cataly update <check|install|status|rollback|cache> [--version TAG] [--from DIST] [--home PATH]
cataly update cache [--prune [--delete-quarantined] [--grace MINUTES]] [--reference DIR]... [--trust-process PID@START]... [--trust-root-cwd] [--home PATH]
```

For example, after obtaining a compatible asset set in `download_dir`:

```sh
"$HOME/.omp-cataly/bin/cataly" update check --from "$download_dir" --home "$HOME/.omp-cataly"
"$HOME/.omp-cataly/bin/cataly" update install --from "$download_dir" --home "$HOME/.omp-cataly"
"$HOME/.omp-cataly/bin/cataly" update status --home "$HOME/.omp-cataly"
"$HOME/.omp-cataly/bin/cataly" update rollback --home "$HOME/.omp-cataly"
```

The commands below remain explicit operations. New builds also include the launch-time automatic path described next. Neither installation nor update enables watchers, services, messenger intake or presence. A stopped activation remains stopped. Each retained release uses its own bound native OMP source across update and rollback.

| Command                                                                                              | Behavior and options                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cataly update check --version TAG`                                                                  | Inspect an exact release without activating it; `check` also accepts `--from DIST`                                                                                            |
| `cataly update install --version TAG`                                                                | Verify and install the selected release; `install` also accepts `--from DIST`                                                                                                 |
| `cataly update install --preview --from DIST`                                                        | New builds: verify and preview configuration changes without preparing dependencies or changing the installation                                                              |
| `cataly update status`                                                                               | Inspect installed state and reconcile an interrupted activation journal                                                                                                       |
| `cataly update rollback`                                                                             | Verify and restore the retained previous release                                                                                                                              |
| `cataly update rollback --version TAG`                                                               | Assert that the retained rollback target is exactly `TAG`                                                                                                                     |
| `cataly update cache [--reference DIR]...`                                                           | Report native cache identities, observed references or unknown uses and exclusive logical bytes; changes nothing                                                              |
| `cataly update cache --prune [--reference DIR]... [--trust-process PID@START]... [--trust-root-cwd]` | Quarantine unused identities and restore copies used again; only dead, unused preparation stages may be removed                                                               |
| `cataly update cache --prune --delete-quarantined [--grace MINUTES] ...`                             | Also remove quarantined copies unused through the grace period, after one more check; you accept that a writer without a lease may publish between that check and the removal |

`cache` is read-only by default: it prints `"removes": "nothing"` and takes no writer lock. It scans native identities for the current platform/architecture under the user home cache, the running release, sources and files under both default homes (`~/.cataly`, `~/.omp-cataly`), selected/loaded installation homes, configured `CATALY_HOME`/`OMP_CATALY_HOME` homes and every explicit `--reference` root. Files of every size are read whole. `bytes` counts logical inode bytes, including directories and internal hardlinks once, but excluding files with hardlinks outside the entry; it does not count allocated filesystem blocks.

An identity's `protectedBy` lists observed references and uses: a source lock or its receipt source still binding it, files such as wrappers/release state/deployment records naming it, links pointing or resolving into it, process arguments or working directories, same-user executables/open files/mappings (including an entry held open as a directory), live leases and native preparations. Working directories use `/proc` on Linux and `lsof` elsewhere; Linux file inspection uses `/proc/<pid>/exe`, `fd` and `maps`. A thread group whose leader exited remains live while other threads run: its lease holds, and its surviving threads' working directories and files are read.

What cannot be ruled out holds conservatively: unrecognized or incomplete receipts, unreadable source or receipt-source locks or leases, unresolved links other than a missing target, linked directories the walk does not traverse, unavailable process working directories or same-user open files, and each live same-user process whose working directory or files cannot be read. Real `.git` and `node_modules` subdirectories are not traversed and add `unscanned directory ...` against every identity unless another supplied root traverses them. Pass `--reference <that-directory>` to inspect one; nested excluded directories retain their own unknown-use reasons, and symlinks bearing those names are still inspected. Unreadable reference files or a failed process listing abort the scan rather than reporting no use.

A running Cataly cache writer keeps every identity, including an older checkout that takes no lease. Recognition uses the base names of command words (`source-dependencies.ts native|assert-native|consumer|lease-path`, `install-source.sh`, `update install|rollback`, `upstream check|stage|watch|restart|recover`), so relative paths count. Its cache is judged by the home it names, relative to its working directory, or its HOME; only another existing, resolved home rules it out. An older `native-stage-*` without an identity/owner also keeps every identity. Root or privileged processes (root, or Linux `CAP_DAC_OVERRIDE`/`CAP_DAC_READ_SEARCH`, excluding kernel threads) whose working directory cannot be read hold every identity. Other users' processes are judged by their arguments only, so an identity directory they can enter is kept.

The report also lists `trustable` (unreadable same-user processes as `PID@START`), `privileged` (unreadable root/privileged working directories) and `pending` (quarantined copies with `since`, intact pre-check interruptions, committed removal remainders with state `"removing"`, dead-owner stages and older preparations). An empty `protectedBy` means only that this point-in-time scan found no use, not exhaustive liveness or permission to delete. References outside the supplied roots are not seen: pass each deployment `releaseRoot` or other checkout as `--reference`.

**Policy: a prune never removes an identity by itself.** `--prune` only quarantines or restores identities; dead, unused preparation stages are the exception described below. An older writer takes no lease and its absence cannot be proven. Removing quarantined identities requires the person's explicit `--delete-quarantined` decision, accepting the residual risk of an unleased writer publishing between the final check and removal.

Native preparation, verification before use, consumer/cache launchers, source installer publication and deployment admission/inspection of explicit cache executables first lease the identity in `~/.cache/omp-cataly/native-leases/<identity>/<pid>-<start>-<boot>`. The holder is the process that will use it, or the shell that execs OMP, so a session's lease lasts through exec. Holders are bound to actual PID/start/boot identity and remain live while their thread group runs. Only then does the writer check `native-prune.lock` with shared nonblocking `flock`, waiting up to five minutes for a prune before failing with a retry message.

A prune takes an exclusive kernel `flock` before reading leases and holds it through the run. Either it sees the lease or the writer waits and then verifies/prepares the identity again. A second prune is refused. The kernel releases a killed holder's lock; the lock file stays. A non-file lock path, such as an empty directory, refuses pruning until deliberately resolved.

Unused live identities are recorded with their quarantine time in `native-quarantine/` and renamed `<identity>.pruning`, so launchers fail instead of running a half-removed identity. Later prunes judge copies under both names. A used copy returns to its live name; a copy whose live name exists again is kept for manual resolution; all other copies stay quarantined however old. Only `--delete-quarantined` considers removal after `--grace MINUTES` (default 10). It renames the copy `<identity>.deleting-<nonce>` and rechecks references, receipts, leases, writers, process arguments, working directories and files under all original three names and the prospective terminal name. A held pre-check copy is restored; an interrupted `.deleting-<nonce>` copy is still intact and returns to quarantine.

After that final check passes, the copy is renamed `<identity>.removing-<nonce>` and the cache directory is synced **before** recursive removal begins. This is a committed, irreversible removal state. A partial removal, a missing/damaged receipt or a newly prepared live image never makes it restorable to the live or `.pruning` name. The live name remains free for re-preparation. Reporting lists the remainder in `pending` with state `"removing"`; ordinary `--prune` keeps it and does not continue deletion.

A subsequent explicit `--delete-quarantined` may finish a committed remainder under the prune lock without restarting its already-completed grace period. The exact direct cache child must be a real, owned directory that is not group/world-writable; entry permissions still protect other users' possible use. References, source bindings, leases, writers, process arguments, working directories, open files and mappings are read afresh for its live, `.pruning`, original `.deleting-<nonce>` and actual `.removing-<nonce>` names. Known or unknown use keeps the committed remainder **in place**, never restores it. Its receipt may legitimately be gone after partial removal, so receipt damage does not turn it into a live identity or permanently prevent explicit cleanup. Cleanup removes only that terminal copy, preserves any newer live image and retains the record of another `.pruning` copy. Races with unleased writers after the final check remain possible.

A preparation named `native-stage-<identity>-<pid>-<start>-<boot>-*` whose owner ended may be removed under the lock only when nothing leases its identity and no process names it, works in it or has a file open in it, including detached git/bun children and surviving threads. Its files are inspected afresh before removal. An older preparation without a recognized owner is only listed and holds identities; remove it by hand only after no older checkout prepares anything. Output lists `removed` (directory, identity, bytes, why), `quarantined` (`since`, `removableAfter`) and `kept` (reasons, including restoration).

`--trust-process PID@START` is repeatable and passes only the named unreadable process while its start time still matches, rechecked under the lock; a reused PID is not trusted. START is Linux clock ticks since boot or the macOS start value read by `procStat` (not verified on a Mac). `--trust-root-cwd` opts out of unreadable privileged working-directory holds, counts them as `rootCwdTrusted` and still checks their arguments. It can miss a privileged process whose only use is its hidden working directory. There is no trust-all-processes flag. These options apply only with `--prune`. A quarantined launch fails until a reference causes restoration, the copy is deliberately restored by hand or the identity is prepared again. Neither the final check nor explicit deletion eliminates races with unleased writers.

`status` and `rollback` do not accept `--from`. Rollback is a retained-source operation; use `install --from DIST` to select a local candidate. Network `check`/`install` without `--version` selects stable latest only. No consumer command ports upstream, runs review models, fetches arbitrary `main`, publishes GitHub changes or grants repository write access.

**Activation holds while a live Cataly is detected, even when it is idle.** Plan a maintenance window. Explicitly stop the monitors you own, end the owning Cataly session using normal runtime controls, inspect `cataly update status`, then retry the install or rollback. The installer and release commands never kill or restart Cataly, consume an approval, alter a paused monitor or pretend a busy hold succeeded.

Failed download, integrity verification or preparation leaves the previously active source and user data in place. Rollback validates the previous release identity and source before switching; it does not undo external work, rewrite config or resume providers/monitors. There must be a valid retained previous release to roll back to. Following an interruption, the next `status`, `install` or `rollback` reconciles the pointer/state journal before continuing. Preserve those records for diagnosis instead of manually replacing pointers or deleting journals.

Install/rollback exit **2** (`release held`) means the attempted activation did not change the selected installed release. Exit **3** (`committed; maintenance pending`) means the selected release changed but a later operation failed, including activation-journal or staging cleanup; `status` reconciles an outstanding activation journal. Exit **4** (`release outcome unresolved`) means the controller could not establish a consistent pointer/receipt result; preserve the records and inspect with the same controller's `status`. These nonzero outcomes are not interchangeable. Automatic update status likewise records a verified committed installation as `installed` with a maintenance detail rather than `held` or `failed`.

## Automatic updates through verified releases

New consumer builds check the canonical **stable Cataly release** channel before an ordinary primary or isolated `omp` launch, at most once per 24 hours per installation. They install a strictly newer compatible release through the same verified bundle, consumer lock, staging, activation journal and rollback path as `cataly update install`. That release supplies its own native source and Cataly code together. There is no separate mutable checkout, arbitrary-upstream execution, prerelease opt-in, downgrade or native OMP self-updater. The launch resolves the selected source again before building extension arguments.

The first eligible launch checks immediately; later launches check only when the saved deadline has elapsed. There is no always-running daemon or in-session timer: leaving one session open for days does not update its code. Network release discovery/downloads share a 15-second budget; verified dependency preparation can take longer under the existing bounded preparation commands. A live Cataly **or lane**, or another guarded OMP launch/session, holds automatic activation, including a session that appears while staging. Short PID/start-identity launch leases serialize admission with reference/pointer publication, without holding a startup gate over downloads. Independent admissions compute their bound Git trees through private index copies rather than contending on a shared Git index lock. Nothing kills/restarts those sessions. Failed/offline checks retain a verified current install and record a daily retry deadline. Local source, dependency, receipt or pointer drift still blocks launch rather than being repaired silently.

```sh
cataly update auto status                  # last result, next check, enabled state
cataly update auto disable                 # persistent per-installation opt-out
cataly update auto enable                  # re-enable and make the next launch eligible
CATALY_AUTO_UPDATE=0 omp                    # pause only this launch
# For a separate home, use its bin/cataly or append --home /absolute/installation
```

An explicit rollback pauses automatic updates until `cataly update auto enable`; it does not immediately reinstall the release you rejected. Version/help probes, prepared `--no-extensions` launches and managed startup do not start a network check. Explicit native overrides remain user choices rather than automatic targets. Existing config, authentication and model choices are not rewritten by the automatic path; the native wrapper's update fence remains in force. Primary user-owned `omp.yml` bytes are preserved. An isolated consumer's generated `omp.yml` is an existing hash-owned reference: owner edits hold instead of being overwritten, even with automatic checks disabled. Resolve that ownership conflict deliberately rather than deleting admission checks.

**Distribution boundary:** this only applies after installing a release containing the launch hook. Source-owned homes and custom source/ref/path installations are not silently migrated. A merged PR alone does not publish a release or update installed clients; until a compatible newer stable release exists, an eligible launch keeps its current installation. Source users continue their explicit source-install/update procedure.

An installation of a release published before the Cataly rename never updates to Cataly, automatically or manually; install Cataly and it [moves your settings over](#cataly-is-a-new-product-moving-from-omp-dori). Current installers select references from the verified target on update or rollback and hold on missing or changed renderer source or modified owned settings.

## Troubleshooting and support reports

- **No stable latest release:** select a prerelease explicitly with `--version vX.Y.Z`. A prerelease is not an automatic latest fallback.
- **Missing/wrong toolchain:** current headless releases require git and Bun 1.4.4+ and verify their bound OMP receipt. The bootstrap does not replace global tools. Source installation also needs a Rust toolchain: without `cargo` and `rustc`, or when its Cargo build fails, it stops with `Cataly requires its native binary` before changing links, wrappers or configuration. Install Rust with [rustup](https://rustup.rs) and rerun it, or install a release on Linux x64 or macOS arm64.
- **Lanes, the lead or duty do not start (`run on the native Cataly binary, and none is installed`):** every headless lane, lead and duty session is hosted by the native binary (`cataly headless-host`); only the two scheduling loops still run on Bun. Cataly looks for `CATALY_DISCORD_NATIVE_BIN` (absolute), then the running code tree's `native-bin/<platform>-<arch>/cataly` and the managed deployment's `target/managed/release/cataly`, then `$CATALY_HOME/bin/cataly-native` (`~/.cataly` when `CATALY_HOME` is unset), and found none. Reinstall the release, or rerun the source installer with a Rust toolchain so it rebuilds the binary. A managed source deployment builds the deployed commit's binary while preparing the release and holds, before stopping anything, when Rust is missing or the build fails. If instead the error names a binary that `exited ... before proving startup`, that binary is too old to have `headless-host`; rebuild or reinstall it. `CATALY_DISCORD_NATIVE_BIN=off` turns off only the Discord-native features and does not affect this lookup.
- **Checksum/manifest/archive failure:** stop using that download. Retain the error, confirm the canonical owner/tag, and download the complete matching asset set again. Do not disable checks or combine files from different releases.
- **Live actor, unmanaged source or path collision:** keep the existing source/state intact and resolve the reported ownership or session condition. A hold is a nonzero result, not an installed update.
- **Interrupted activation:** run the installation's `bin/cataly update status` and retain the release state/journal if it reports an unresolved inconsistency. Do not hand-edit the active pointer to manufacture success.
- **Discord messages work but the bot is offline:** inspect the opt-in Gateway presence monitor, its genuine READY/RESUMED and heartbeat logs, your token/intents and the actual Discord indicator. REST success alone proves none of these.

For a support report, include the exact tag, release commit/source hash shown by the manifest or status, OS/architecture, Bun/OMP versions, selected runtime, command and sanitized output. State whether the input was a canonical network release or `--from`. Report checksum failure, skipped checks and unexercised behavior honestly. Exclude tokens, auth files, private session transcripts and project data. Use the repository's [issues](https://github.com/vntrevx/Cataly/issues) after reviewing what you are submitting.

## Source checkouts for maintainers

Source installation is separate from public release installation. Use an ordinary checkout outside the frozen consumer release directories:

```sh
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/omp-cataly"
cd "$HOME/src/omp-cataly"
CATALY_INSTALL_MODE=side CATALY_NO_PULL=1 CATALY_SRC="$PWD" bash scripts/install-source.sh
```

Add `--preview` to the source install command to inspect configuration changes without invoking `CATALY_OMP`, disclosing owner configuration values, fetching or updating a checkout, installing packages, or changing references. It requires the selected local checkout and example configuration; use `CATALY_SRC` to select the checkout you intend to install. Each install takes a fresh snapshot, so preview output is not a reusable authorization token.

Source JSON preserves unknown keys, explicit custom argv and remaining managed argv arguments. It manages the default `agentCommand` prefix; a fresh side configuration also gets its own `stateDir`. Side YAML retains owner mappings and model/memory values while refreshing only the existing managed keys: `skills.ignoredSkills`, `skills.customDirectories` and `update.auto: false`. Unchanged source JSON and existing consumer JSON retain their original bytes. A needed source JSON/YAML rewrite refuses invalid UTF-8 instead of replacing owner bytes. When a valid file must change, values are preserved, not comments or original formatting. Neither path enables global memory, probes an account or starts a model.

The checkout installer lives at **`scripts/install-source.sh`**; root `install.sh` remains the consumer release bootstrap. Source installation retains fast-forward-only checkout updates when pulling is enabled and frozen root/skill/extension package installation. `CATALY_NO_PULL=1` installs the selected checkout as it is. `CATALY_SRC` selects an ordinary source checkout. Keep the full sibling source layout rather than copying the skill alone. Before any dependency, link, wrapper or configuration change, the installer obtains the required native Cataly binary: a checkout's `native-bin/<platform>-<arch>/cataly` when present, otherwise `cargo build --locked --release --bin cataly` for the host. When pulling, it builds the incoming upstream commit from an export of that commit before fast-forwarding, so the checkout moves only once the binary exists. Without a Rust toolchain, or when that build fails, it stops with guidance to install Rust with [rustup](https://rustup.rs) or to use a release; the checkout stays at its current commit. It publishes the binary as `<install-home>/bin/cataly-native`. Checkouts from before the Rust crate have no native binary to install.

`CATALY_INSTALL_MODE=side` uses `OMP_CATALY_HOME` (default `~/.omp-cataly`) for its own config, state, generated skill and wrappers. Source lives there unless `CATALY_SRC` is explicit; bound dependencies live in the home-local cache. It changes no primary `~/.cataly` files, global `cataly` command, `cataly-mode` skill link or global OMP extension links. Only `omp-cataly` is linked in `OMP_CATALY_BIN_DIR` (default `${BUN_INSTALL:-$HOME/.bun}/bin`). Side homes and path overrides must remain separate from the primary home.

The side `bin/{cataly,omp,omp-cataly}` wrappers source `env.sh`, which sets `CATALY_HOME`, `CATALY_CONFIG`, `CATALY_STATE_DIR`, `CATALY_AGENT_ARGV` as a JSON array containing their owned `bin/omp`, and the side `PATH`, and clears inherited `CATALY_AGENT_CMD` and `CATALY_AGENT_EXECUTABLE` overrides. The harness quotes every selected argument for shell execution; argv consumers preserve the complete command. A new config's `stateDir` stays inside the side home and `agentCommand` uses its `bin/omp`. `omp-cataly omp` passes `--no-extensions -e <src>/extension --config <home>/omp.yml`; the generated overlay hides `cataly-mode` and discovers the renamed `omp-cataly-mode` skill. No globally discovered extension is loaded. Generated wrappers, overlay and skill copy refresh on reinstall; existing config choices remain. The `.omp-cataly` marker keeps later runs in side mode without a prompt. These paths and configured checkout aliases are checked before source/package mutations.

`CATALY_INSTALL_MODE=primary` retains the unmanaged source workflow in `~/.cataly`, including global skill/extension links. After frozen dependency installation, it links the executable skill CLI directly as `cataly` in `OMP_CATALY_BIN_DIR` (default `${BUN_INSTALL:-$HOME/.bun}/bin`), without Bun global package registration. `SKILLS_DIR` and `OMP_EXTENSIONS_DIR` select the skill and extension link locations. When taking over another unmanaged Cataly or replacing a foreign `cataly` symlink, the previous config, when present, and link targets (including `cataly` on `PATH`) are saved under `~/.cataly/backups/omp-cataly-install-*` after a successful source pull and before link/config changes. An existing regular `cataly` file is preserved and stops installation; move it aside or select another `OMP_CATALY_BIN_DIR`. A foreign default `~/.cataly/src` stops before changes; failed fetch/fast-forward attempts leave no backup. Without an explicit mode, another unmanaged Cataly prompts in a terminal with side as the default, and holds without a terminal or on EOF. Earlier unmanaged omp-cataly installs are recognized by the marker, source files rather than remote names, or their extension link; a home holding only `state/` remains eligible for primary installation.

Primary mode also generates `~/.cataly/bin/omp`; start the lead through that wrapper rather than a pre-existing stock `omp` on PATH. Both modes migrate only the default `agentCommand` executable (`omp`, or an absent command) to their wrapper, preserving the remaining arguments and explicit custom commands. Source installation never replaces the global native OMP executable.

Consumer control records (`consumer-owner.json`, `consumer-installed.json`, `consumer-journal.json` under the release root) and the managed source pointer protect a consumer home before source checkout or package changes. The source marker or omp-cataly extension link never overrides that protection. Primary source installation holds there: use its `cataly update check|install|status|rollback` commands. A selected side home that directly names or aliases any consumer home also holds, including incomplete consumer control state. Choose a separate ordinary checkout and side home; this installer performs no consumer migration or repair.

Use a separate messenger bot/channel. Start the source lead with `omp-cataly harness up`. Installation starts neither the lead nor any watcher. See the [container recipe](container.md) and [contributor checks](../CONTRIBUTING.md).

Maintainer upstream porting uses:

```text
cataly upstream <check|stage|watch|status|snapshot|restore|recover|restart> --config FILE
```

This is the former porting updater, with no `cataly update stage/watch` alias. Its worker/reviewer models, checks, promotion policy, recovery and external supervisor remain documented in the [staged-update reference](../skills/cataly-mode/references/scripts.md#staged-cataly-updates). Maintainers supply their own model/provider authentication and, only when publishing, repository permissions. A ready source candidate is not a consumer release or an automatic live deployment.

### Managed deployments from the previous main

A lead that the previous main started (before the legacy removal) writes its runtime health with `presetLoaded`, and that main's controller recorded toolchain receipts that pin the extension through the removed omp-ulw overlay. This version's controller reads both in the current shape, so its first managed deployment replaces such a lead through the ordinary path: the releasing source's `cataly harness stop`, the pointer switch, `cataly harness up` resuming the recorded lead session, health readback and, on failure, rollback to that session. Every other hold still applies. A controller that still runs the previous main holds that deployment before it stops anything, because it cannot prepare the removed overlay, so the previous version keeps running. The installer therefore hands such a deployment over itself: for a source-mode supervisor whose controller still holds `omp-ulw.overlay.lock`, it runs this version's `update source apply --when idle` once, from the version being installed, and that deployment switches the controller link through the ordinary path above. An upstream-mode supervisor starts no model work for a controller change, so the installer only prints that the move completes when its next deployment runs this version; if a source deployment cannot move yet, the same line is printed and the next install retries.

## Building and publishing releases

The root `package.json.version` is canonical. From the actual committed release source, build the first preview with:

```sh
bun scripts/release.ts build --out ./dist --prerelease
```

The general interface is `bun scripts/release.ts build --out DIST [--prerelease] [--native DIR]`. The producer packages actual committed HEAD, rather than uncommitted worktree bytes or an arbitrary private source snapshot. It preserves executable bits, binds the public source manifest to the commit/tree and writes the four fixed assets listed above. For another version, archive and root names are derived as `cataly-v<version>.tar.gz` and `cataly-<version>/`.

The archive carries the native Cataly binary for each supported host. The producer builds its own host's binary from the extracted committed tree with Cargo, without user Cargo configuration, compiler flags or linker settings. A binary it cannot build arrives through `--native DIR` as `DIR/<platform>-<arch>/cataly`, made on its own host from the same commit by `bun scripts/release.ts native --out DIR`. That command builds twice in independent scratch trees, requires byte-identical results and checks the executable format. `gate` and `publish` accept the same `--native DIR`, regenerate the distribution from committed HEAD plus those bytes, and refuse a distribution without executable binaries for both Linux x64 and macOS arm64. A local build without `--native` contains only its own host's binary; it serves consumer smoke tests, not publication. The binaries are ordinary source-manifest entries. The manifest is schema version 2, with product `cataly` and a single `requirements.omp` field; updaters from releases published before the Cataly rename cannot read it.

Before publication, maintainers perform isolated real-binary install/update/failure-recovery QA without personal HOME/auth/history mounts, review the change freshly and obtain the required CI evidence for the exact release commit. Report the actual results separately: source checks or a historical port replay are not a future clean-consumer run, a provider test or an independent external-user beta.

Use the [per-run evidence contract](../.github/pull_request_template.md#evidence) for release QA too. Link actual receipts with observed source/native identities (including the native overlay), OS/architecture, exact commands, runtime/fixture setup, synthetic/loopback/live provider boundaries, and unverified surfaces. Pins are intended inputs, not observed runtime proof; explain unknown or N/A. Rerun affected checks after relevant source, runtime, or environment changes, or keep that claim unverified rather than carrying old receipts forward.

The `.github/workflows/release.yml` tag workflow has two jobs. `native-darwin-arm64` runs on `macos-15` with the pinned Rust toolchain, builds the reproducible macOS arm64 binary with `release.ts native`, runs `cataly --version` and uploads it with its SHA-256 as a job output. `publish` runs after it on Linux x64, checks the downloaded binary against that digest and passes it as `--native` to `build`, `gate` and `publish`. It validates the tag against the canonical package version. It requires a successful **`check`** result for that exact commit from the repository's own CI workflow and the trusted GitHub Actions app **15368**. A tag push alone does not prove `ci.yml` ran. The separate `.github/workflows/cross-os.yml` workflow reports macOS and Windows results on pull requests and `main` pushes, but it is outside this release gate and forms no part of release evidence. The first release is explicitly marked prerelease. Existing tags, releases and assets must not be overwritten; publication needs maintainer permissions and consumers need none.

Every maintainer release-metadata mutation names the tag and commit identity explicitly and reads back the known release ID rather than re-resolving a draft by tag; a body-only draft update can drop that draft's tag binding. The local producer publication path uses the GitHub CLI and needs a `gh` that supports `--paginate` together with `--slurp` for paginated API reads, including release-asset listing, which the trusted Actions runner provides; an older host `gh` without `--slurp` is not a supported producer environment. This is a maintainer tool requirement only: consumer install, check, update and rollback still need no `gh`.

Each binary asset upload sends an exact `Content-Length` from the existing payload's `byteLength`, as required by the [GitHub release asset API](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28#upload-a-release-asset). The stateful producer fixture rejects missing, malformed or mismatched lengths against the actual stdin bytes with HTTP 400.

After publishing, read back the actual release metadata/assets, checksums and tag/commit identity before claiming publication complete. Add the actual QA/CI evidence to the release notes. This procedure makes no claim that an unrun check or an unpublished asset already exists. [LICENSE](../LICENSE), [LICENSE.integration](../LICENSE.integration), [NOTICE](../NOTICE) and third-party pin/notices remain in force; the source-available upstream license has not been replaced.
