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
  <a href="https://github.com/vntrevx/Cataly/releases/tag/v0.1.2"><img alt="Published preview" src="https://img.shields.io/github/v/release/vntrevx/Cataly?include_prereleases&label=preview&labelColor=2b2d33&color=c8102e"></a>
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
   coding session in herdr or hc, with a brief and an explicit `Done` condition.
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
- Optional telemetry can be disabled with `DORI_TELEMETRY=0` or `DO_NOT_TRACK=1`.

## Get started

<table width="100%"><tr><td>

**Note**

Cataly is the project name. The CLI and launchers still use `dori`, `omp-dori`,
and `omp`; existing install paths and release asset names are unchanged.

</td></tr></table>

|                | [Published preview](#try-the-published-preview) | [Current source](#work-from-current-source)          |
| -------------- | ----------------------------------------------- | ---------------------------------------------------- |
| **Build**      | v0.1.2 prerelease                               | current `main`                                       |
| **Scope**      | Linux x64 / herdr / Discord                     | herdr or hc, your chosen messenger                   |
| **OMP**        | independently installed native OMP 18.18.8      | pinned, patched OMP 18.20.0 with the omp-ulw overlay |
| **Home**       | primary `~/.dori`                               | side mode `~/.omp-dori`                              |

### Try the published preview

The [v0.1.2 prerelease](https://github.com/vntrevx/Cataly/releases/tag/v0.1.2)
is the published **Linux x64 / herdr / Discord** preview. The tested baseline
is Ubuntu 24.04 x64, Bun 1.4.4, native OMP 18.18.8, and herdr 0.9.5. This tag
requires an independently installed OMP and uses the primary `~/.dori` home.
It does not contain the newer `main` features or toolchain.

1. [Install the exact preview](https://github.com/vntrevx/Cataly/blob/v0.1.2/docs/releases.md#install-the-exact-preview).
   Check its [prerequisites](https://github.com/vntrevx/Cataly/blob/v0.1.2/docs/releases.md#prerequisites-and-trust)
   and verify the matching release assets before running their installer.
2. [Configure your provider and Discord bot, then start Dori](https://github.com/vntrevx/Cataly/blob/v0.1.2/docs/releases.md#your-authentication-and-explicit-startup).
   Use your own provider account and allowance, bot token, owner ID, and channel ID.
3. [Enable Discord intake](https://github.com/vntrevx/Cataly/blob/v0.1.2/docs/releases.md#discord-owner-intake).
   Wait for `INBOUND_READY`, then send a fresh message in the configured channel.
   Old messages are not replayed on first start.

### Work from current source

Use a separate checkout with git, Bun 1.4.4+, and your chosen runtime (herdr or
hc). The default source installer prepares the pinned, patched **OMP 18.20.0**
and **omp-ulw** overlay; a stock `omp` is not a substitute. No preinstalled OMP
or Cargo is needed for this default setup.

To inspect configuration changes first, add `--preview` to the final command below;
review its paths and hashes, then run it without that flag to install. The preview
does not update the checkout, prepare dependencies, or change installation files.

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" \
  bash scripts/install-source.sh
```

Side mode uses `~/.omp-dori` by default and leaves the primary `~/.dori`
installation alone. After configuring the side home, use `omp-dori omp` to
start OMP through the generated wrapper. Follow the
[source setup and startup guide](docs/releases.md#source-checkouts-for-maintainers)
for your runtime and messenger. Use `omp-dori doctor` for a read-only setup
check and `omp-dori status` to see your lanes.

<table width="100%"><tr><td>

**Important**

**Support boundary:** Slack and Telegram are retained source integrations, not
part of the published preview. The installer can support isolated macOS arm64 / hc
consumer profiles declared by a compatible release manifest; no such release is
claimed here. A merge to `main` does not update the published preview.

</td></tr></table>

## Documentation

| Set up and operate                                                          | Go deeper                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Installation, support, updates, and rollback](docs/releases.md)            | [Runtime adapters and session contracts](docs/runtime.md)                       |
| [Messenger setup](skills/dori-mode/references/setup.md)                     | [Container setup for source development](docs/container.md)                     |
| [Dori operating rules](skills/dori-mode/SKILL.md)                           | [Scheduling and backlog](docs/hourly-loop.md)                                   |
| [Lane commands and configuration](skills/dori-mode/references/scripts.md)   | [Shared locks and lane priority](docs/locks.md)                                 |
| [Done protocol](skills/dori-mode/references/done-protocol.md)               | [Opt-in paid Discord voice assistant (current source)](docs/discord-voice.md)   |
| [Changelog](CHANGELOG.md)                                                   |                                                                                 |

## Contributing

Start with the [contribution guide](CONTRIBUTING.md), check the
[issues](https://github.com/vntrevx/Cataly/issues) and
[pull requests](https://github.com/vntrevx/Cataly/pulls), and bring a focused
change with evidence that it works.

## Licenses and attribution

Cataly integrates [dori-superagent](https://github.com/sisyphuslabs/dori-superagent),
[oh-my-pi](https://github.com/can1357/oh-my-pi), and
[omp-ulw](https://github.com/dbc-hbin/omp-ulw). The dori-superagent-derived
material retains the [Sustainable Use License 1.0](LICENSE). The existing OMP
integration retains its [MIT license and copyright notices](LICENSE.omp-dori);
the MIT notice does not apply to the whole repository. Other components keep
their own terms. See the [licensing guide](LICENSING.md) and [NOTICE](NOTICE) for
source revisions and modified-copy attribution.
