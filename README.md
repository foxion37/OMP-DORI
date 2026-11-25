<p align="center">
  <img src="docs/cataly-portrait.webp" width="320" alt="Cataly character portrait: silver hair and a crimson halo">
</p>

<h1 align="center">Cataly</h1>

<p align="center">
  <strong>Understand the intent. Read the context. See the work through.</strong>
</p>

<p align="center">
  Cataly is an AI teammate for software work. Give it a goal and the constraints
  that matter, not a command for every step. It can take a request from Discord,
  work in a tracked coding session, and bring back a result you can verify.
</p>

<p align="center">
  <a href="https://github.com/vntrevx/Cataly/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/vntrevx/Cataly?include_prereleases&label=release&labelColor=2b2d33&color=c8102e"></a>
  <a href="https://github.com/vntrevx/Cataly/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI on main" src="https://img.shields.io/github/actions/workflow/status/vntrevx/Cataly/ci.yml?branch=main&label=ci&labelColor=2b2d33"></a>
  <a href="LICENSING.md"><img alt="License: SUL 1.0 with a scoped MIT notice" src="https://img.shields.io/badge/license-SUL%201.0%20%2B%20scoped%20MIT-8b9099?labelColor=2b2d33"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.4 or later" src="https://img.shields.io/badge/bun-%E2%89%A51.4.4-8b9099?labelColor=2b2d33&logo=bun&logoColor=white"></a>
</p>

<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#how-it-works"><strong>How it works</strong></a> ·
  <a href="#documentation"><strong>Documentation</strong></a> ·
  <a href="#contributing"><strong>Contributing</strong></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a><br>
  <a href="README.de.md">Deutsch</a> · <a href="README.it.md">Italiano</a> · <a href="README.zh.md">中文</a>
</p>

## Give it an outcome, not a script

<table width="100%"><tr><td>

**Example request**

*Investigate the flaky login test. Keep the public API unchanged, run the
relevant tests, and open a PR with the cause and the verification results.*

</td></tr></table>

<table>
  <tr>
    <td width="33%" valign="top">
      <h4>Understand the intent</h4>
      The flaky test is the symptom. The goal is a fix you can review, with the
      public API intact. Cataly uses that distinction to choose what to
      investigate and what to leave alone.
    </td>
    <td width="33%" valign="top">
      <h4>Read the context</h4>
      The conversation, repository conventions, constraints, and your stated
      preferences inform the next step. Routine decisions belong to Cataly; real
      tradeoffs and permission decisions belong to you.
    </td>
    <td width="33%" valign="top">
      <h4>See the work through</h4>
      A patch is not the finish line. Check the agreed outcome, report the
      evidence, and say what remains unverified.
    </td>
  </tr>
</table>

The difference is not another chat interface. It is the link between the request,
its working session, and the evidence that it is done.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-it-works-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/how-it-works-light.svg">
  <img src="docs/how-it-works-light.svg" width="100%" alt="Workflow: a request arrives, the lead assigns it, a lane works and reports, and completion is checked before a result you can verify, with its evidence, comes back to you.">
</picture>

Here is the workflow on current `main`:

1. **A request arrives.** With Discord intake enabled, Cataly reads messages from
   the configured owner and carries available reply context and attachment
   metadata into the work.
2. **The lead assigns the work.** The lead can handle small requests directly or
   launch a **lane**: a dedicated [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi)
   coding session with a brief and an explicit `Done` condition. Native sessions run without a terminal.
   The lane registry ties the work to its session and messenger thread.
3. **The lane works and reports.** Worklogs, reports, and checkpoints make
   progress inspectable across restarts. Ordinary Discord chat
   for an unambiguously linked lane reaches that lane’s native OMP session;
   an exact reply to a supported ASK form answers the form instead.
4. **Completion is checked.** A lane’s “done” claim is not proof. The Done flow
   can read back a command result, file state, merged PR, or published package
   version. A passing check proves that signal, not every possible outcome.

## You stay in control

- Cataly uses your accounts and permissions. Taking initiative does not grant
  permission for external actions.
- Installation starts no agent, messenger receiver, or service. Enable only the
  monitors and integrations you want.
- Keep credentials and private transcripts out of public reports.
- Optional telemetry is off by default. Set `CATALY_TELEMETRY=1` to opt in;
  `DO_NOT_TRACK=1` overrides it.

## Get started

<table width="100%"><tr><td>

**Cataly is a new product, not an upgrade of omp-dori**

This version removes every omp-dori name, the herdr and hc terminal runtimes and
the omp-ulw overlay, and although omp-dori code cannot be upgraded in place, the
installer does the move itself: it imports a previous `~/.dori` or `~/.omp-dori`
home's config, tokens and owner profile into the new home without overwriting
settings already there, then deletes that home and the links and caches the
previous version left behind once nothing of it runs
([how the move works](docs/releases.md#cataly-is-a-new-product-moving-from-omp-dori)).

Use `cataly` for operation, `cataly-harness` for the standalone harness, and
`omp-cataly` for a separate installation. Fresh homes default to `~/.cataly`
(primary) or `~/.omp-cataly` (side).
[Install a verified current release](docs/releases.md#install-a-current-release).
Cataly runs on headless OMP by default on macOS and Linux; Tern is the optional terminal runtime.

</td></tr></table>

### Install the npm package

With Bun 1.4.4 or newer available on `PATH`, run one of these in your project
directory:

```bash
npm install cataly
# Or, with Bun:
bun add cataly
```

The Cataly package exposes `cataly-harness`:

```bash
./node_modules/.bin/cataly-harness --help
```

This installs the harness CLI, not the full OMP and messenger setup. For that
setup, [install a verified release](docs/releases.md#install-a-current-release)
or work from current source.

### Work from current source

Use a separate checkout with git, Bun 1.4.4+ and a Rust toolchain from
[rustup](https://rustup.rs). On Linux and macOS sessions
run on headless OMP by default; no terminal server is needed. The installer prepares the pinned, patched **OMP 19.0.1**;
a stock `omp` is not a substitute. No preinstalled OMP
is needed. The installer builds the required native Cataly binary with Cargo;
without a Rust toolchain, or when that build fails, it stops before changing links,
wrappers or configuration. Releases bundle the binary for Linux x64 and macOS arm64 instead.
Tern is the optional terminal runtime; see [Tern](docs/runtime.md#tern).

To inspect configuration changes first, add `--preview` to the final command below;
review its paths and hashes, then run it without that flag to install. The preview
does not update the checkout, prepare dependencies, or change installation files.

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
CATALY_INSTALL_MODE=side CATALY_NO_PULL=1 CATALY_SRC="$PWD" \
  bash scripts/install-source.sh
```

Side mode uses `~/.omp-cataly` by default and leaves the primary `~/.cataly`
installation alone. Use `omp-cataly omp` to open the bound OMP for provider
setup, and `omp-cataly harness up` to start the harness explicitly. Follow the
[source setup and startup guide](docs/releases.md#source-checkouts-for-maintainers)
for your messenger. Use `omp-cataly doctor` for a read-only setup
check and `omp-cataly status` to see your lanes.

`cataly harness status` shows `RUNTIME headless (from default)`.

Opt-in [source updates](skills/cataly-mode/references/scripts.md#ci-gated-source-updates)
follow CI-passing main with idle and quiet admission, same-session restart,
monitor health, and rollback. This is separate from consumer release updates
and the model-assisted `cataly upstream` workflow.

### Develop the Rust controller for stock OMP

This opt-in CLI does not change the default source installation above. Build
it with Cargo, then run it by path so it does not replace an installed
`cataly` command:

```bash
cargo build --locked --release
./target/release/cataly --omp "$(command -v omp)" doctor
./target/release/cataly --omp "$(command -v omp)" harness --state-dir ./.cataly-native <<'JSON'
{"op":"run","id":"request-1","key":"review","prompt":"Explain the task in one paragraph."}
{"op":"receipt","id":"request-1"}
JSON
```

`doctor` probes RPC without submitting a prompt. `resume` verifies an exact
OMP session file and ID. On Unix, `harness` starts a lane on demand and can
resume it from a separate state directory on the next request. `open`, `status`,
and `close` also manage resident sessions explicitly. Repeating a request ID
with the same input retrieves the stored receipt without another model call;
uncertain requests are held, not replayed. `run` uses the configured OMP model
and currently returns text only. It does not handle tools, approvals, or
messenger delivery.

For interactive clients, `run_controlled` accepts the same fields as `run`.
While it is active, send `{"op":"run_status","id":"request-1"}` or
`{"op":"cancel","id":"request-1"}` on the same stream. Control replies carry
`control: "running"` or `"cancelling"`; the run's receipt arrives separately.
Cancellation before dispatch leaves no run claim. After dispatch, Cataly closes
the lane's OMP process. An unconfirmed outcome is not a rollback and must not
be automatically replayed.

`run_with_tools` takes the same fields and opens a new or parked lane with
one read-only tool, `cataly_read_readme`. When OMP calls it, Cataly emits
`{"id":"request-1","approval_id":"…","tool":"cataly_read_readme"}`.
On the same stream, reply with
`{"op":"decide","id":"request-1","approval_id":"…","decision":"approve"}` or
use `"deny"`. Only an exact, pending approval ID is accepted. The decision
acknowledgement is separate from the final run receipt. Approval reads only
the lane's `README.md`: a regular UTF-8 file up to 16 KiB with no symbolic or
hard links. Denial or disconnect before approval discloses no file content.
`run` and `run_controlled` still use the text-only path.

Build with `cargo build --release`. On Unix, the Rust binary can run Discord
without Bun: `target/release/cataly --cwd "$WORKSPACE" discord --state-dir "$STATE_DIR" --channel "$CHANNEL_ID" --gateway`.
Set `CATALY_DISCORD_TOKEN` and `CATALY_DISCORD_OWNER_ID` in its environment.
Without `--gateway`, Rust uses REST polling; `--poll-seconds 0` runs one poll.
The existing `cataly inbound discord` can launch the Rust monitor with:

| Setting | Value |
| --- | --- |
| `CATALY_DISCORD_NATIVE_BIN` | Optional absolute override for the native Cataly binary, used by Discord intake and the headless lane, lead and duty host. `off` keeps the TypeScript Discord sends, presence and routing, and Discord intake then refuses to start; the headless host still uses the bundled or installed binary. |
| `CATALY_DISCORD_NATIVE_WORKSPACE` | Optional absolute workspace override for the native monitor; otherwise it uses `laneWorkspace`. |
| `CATALY_DISCORD_NATIVE_CHANNEL_ID` | Optional exact channel or thread ID from the inbound list. If unset, use all explicitly listed inbound channels as roots. |
| `CATALY_DISCORD_THREADS` | Follow active threads under those roots by default. Set `off` to watch only explicit IDs. Direct Rust invocation uses `--follow-threads`. |
| `CATALY_OMP` / `CATALY_DISCORD_NATIVE_MODEL` | Optional OMP executable and model overrides. |

Rust owns Gateway heartbeat and resume, REST history and sends, button
callbacks, and the OMP lane. Each discovered thread has its own cursor, lane,
and reply destination. Stop any other Discord receiver on the same state
before switching; `cataly inbound discord` imports the TypeScript receiver's
cursors on first use. With the native
binary installed, supervised monitors share one on-demand Rust process per OMP
supervisor for ASK replies and head admission against persisted OMP receipts.
The OMP extension still owns the active session, its admission queue, and
`message_end` delivery. An interrupted routing request is not silently replayed
or redirected to the head.
Discord intake is Rust-only. Under the OMP `monitor` tool, `cataly inbound discord`
(filter `^INBOUND`) replaces itself in place with `cataly discord --supervised`,
keeping its PID, stdout and IPC channel. `CATALY_DISCORD_SCOPE=all`, `--context`,
`--activity-file`, recall and `--wake-lanes` all run in Rust. `--wake-lanes` starts a lane's
OMP directly, headless. The OMP extension still owns the live session.
Without the native binary, `cataly inbound discord` fails and names the build command.

For a head owned entirely by Rust, run a separate receiver with
`--head-channel "$CHANNEL_ID"` and an explicit `--channel "$CHANNEL_ID"`.
Only that conversation goes to the head; other configured channels and threads
keep independent lanes. The receiver loads the exact saved `head` identity in
`--state-dir`, or creates it on the first turn, and parks OMP again when the
turn finishes. Do not open the same native state or transcript in another OMP
process. Pass `--ask-state "$CATALY_STATE_DIR"` (an absolute path) to consume
answers for existing ASK mailboxes before starting a turn.

For the installed CLI, set `CATALY_DISCORD_HEAD_CHANNEL_ID` to one of the
explicit inbound channels and run `cataly inbound discord --gateway` outside
an interactive OMP monitor. Its state is `$CATALY_STATE_DIR/discord-head`.
Stop the old receiver before switching. Rust takes over its `gateway.sqlite`
queue and cursors in `$CATALY_STATE_DIR/discord-inbound`: a pending head
admission is settled only from its original OMP receipt, and the queue is
kept untouched while that receipt is missing. Rust never takes over a live
interactive OMP session.

When the native binary is installed or bundled, `cataly send discord` and
`cataly presence discord` select it automatically. To run without Bun or OMP:
`target/release/cataly discord-send --thread "$THREAD_ID" < reply.txt`.
Use `--reply MESSAGE_ID` to reply or `--edit MESSAGE_ID` to update a single
message. For a channel, use `--to CHANNEL_ID` or a unique `--to '#name'`
in `CATALY_DISCORD_GUILD_ID`. The direct command emits a JSON delivery receipt.
Long fenced Markdown closes and reopens its code block at each UTF-16-safe cut.
Use `target/release/cataly discord-presence` to run only the Gateway presence connection.
Release archives contain the checksummed Rust binary for Linux x64 and macOS arm64.
Source installs build it with Cargo and stop before changing links, wrappers or
configuration when no Rust toolchain is available or the build fails.

Ordinary owner text runs with OMP's tools disabled; attachments are not
downloaded. Follow-ups reuse the saved session, and the OMP process exits
between turns. On Gateway, `!cataly <request>` enables the approval-gated
README tool when OMP advertises host tools. Use private channels: results are
visible to channel members and reply to the original message.

Rust records a send intent before each Discord reply part and saves the remote
message ID after confirmation. Restarting does not rerun completed requests or
repeat confirmed parts. If a POST cannot be confirmed, that part and later
parts are held rather than retried blindly. Check the monitor for
`DISCORD_REPLY_HELD` and inspect the original thread and the native state
directory before reconciling a receipt.

#### Local memory for native Discord

The native monitor uses the local [ai-memory](https://github.com/akitaonrails/ai-memory)
installation when `~/.local/bin/ai-memory` exists. Use `CATALY_MEMORY_BIN`
to select another absolute binary path, or set it to an empty value to turn
off native checkpoints. The recorder is a separate bounded local worker,
not another model call. It indexes notes on `127.0.0.1:49374`; if the server
is down, private checkpoints remain on disk for later export.

Cataly checkpoints bounded owner text to its room. It exports after eight
new notes, on the ten-minute maintenance tick, or when the session reaches
16 MB, before the 20 MB warning point. For durable notes use
`!remember room …`, `!remember person …`, `!remember project …`, or
`!remember common …`. These commands save locally without launching OMP.
Only explicit notes leave the room scope, and common notes are shared across
projects within the same bot-owner account and state directory, never
between owners. Person notes are not sent into channel replies. Read them
locally in ai-memory. Approved tool output and attachments are not captured.
Checkpoints do not delete, truncate, or rotate the original OMP session.

Cataly depends on the installed OMP's public RPC, not its version string,
SDK, or patched core. The latest official Linux release is tested daily by
the `Cataly Native` workflow alongside pinned release tests on changes.
Use `cataly doctor` to check the installed protocol and optional host tools.
An incompatible RPC change still needs an adapter fix; an ambiguous turn stays
held rather than being replayed. Build with `--no-default-features` if you
only want the OMP harness without Discord's networking libraries.

<table width="100%"><tr><td>

**Important**

**Support boundary:** Slack and Telegram are retained source integrations, not
part of the consumer releases. The installer can support isolated macOS arm64
headless consumer profiles declared by a compatible release manifest; no such release is
claimed here. A merge to `main` does not update a published release.

</td></tr></table>

## Documentation

| Set up and operate                                                          | Go deeper                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Installation, support, updates, and rollback](docs/releases.md)            | [Runtime adapters and session contracts](docs/runtime.md)                       |
| [Messenger setup](skills/cataly-mode/references/setup.md)                     | [Container setup for source development](docs/container.md)                     |
| [Cataly operating rules](skills/cataly-mode/SKILL.md)                           | [Scheduling and backlog](docs/hourly-loop.md)                                   |
| [Lane commands and configuration](skills/cataly-mode/references/scripts.md)   | [Shared locks and lane priority](docs/locks.md)                                 |
| [Done protocol](skills/cataly-mode/references/done-protocol.md)               | [Opt-in paid Discord voice assistant (current source)](docs/discord-voice.md)   |
| [Changelog](CHANGELOG.md)                                                   | [Opt-in owner profile for the lead](docs/owner-profile.md)                      |

## Contributing

Start with the [contribution guide](CONTRIBUTING.md), check the
[issues](https://github.com/vntrevx/Cataly/issues) and
[pull requests](https://github.com/vntrevx/Cataly/pulls), and bring a focused
change with evidence that it works.

## Licenses and attribution

Cataly is derived from [dori-superagent](https://github.com/sisyphuslabs/dori-superagent)
and builds on [oh-my-pi](https://github.com/can1357/oh-my-pi). The
dori-superagent-derived material retains the [Sustainable Use License 1.0](LICENSE).
The existing OMP integration retains its [MIT license and copyright notices](LICENSE.integration);
the MIT notice does not apply to the whole repository. Other components keep
their own terms. See the [licensing guide](LICENSING.md) and [NOTICE](NOTICE) for
source revisions and modified-copy attribution.
