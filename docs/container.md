# Maintainer source-container recipe

This maintainer recipe packages **the local source checkout**, including the complete upstream harness, skill, shared runtime adapters and retained OMP extension. It does not clone a separate Cataly release. Public consumers should follow the [verified release installer and support guide](releases.md). This recipe's build and session checks are separate evidence, not a published or independently validated consumer image. Cataly sessions run on headless OMP; the image contains no terminal server.

The primary `cataly` command runs `skills/cataly-mode/scripts/src/cli.ts`. `cataly harness <args>` dispatches to the complete root CLI; `cataly-harness <args>` and `bun /opt/omp-cataly/src/cli.ts <args>` also reach it. The image never assigns the root CLI the primary `cataly` name.

## Files and build inputs

- `examples/container/Dockerfile`: Ubuntu 24.04, gh, Node, Bun, agent-messenger, OMP and the local candidate at `/opt/omp-cataly`.
- `examples/container/compose.yaml`: one service named `cataly`, default project `omp-cataly-candidate`, project-scoped named volumes and no fixed container name, published ports or host credential mounts. It idles with `sleep infinity`; no runtime server, OMP session, harness, messenger receiver or watcher starts automatically.
- `.dockerignore`: a source allowlist followed by exclusions for dependencies, nested Git metadata, env/auth files and operator state. Keep credentials and private data outside the source directories even when preparing a local build context.

Compose's build context is the candidate root (`../..` relative to the compose file), with `examples/container/Dockerfile` as its recipe. `COPY . /opt/omp-cataly` therefore includes the edited candidate, notices, prompts, tests, extension and full sibling layout. Root, skill and extension dependencies are installed with `--frozen-lockfile`; no host `node_modules` is copied. The source checkout's current bytes, including uncommitted port edits, are the image's Cataly input. There is no `CATALY_REF` clone or build argument.

| Input | Pinned value | Source of the pin |
|---|---|---|
| Base | `ubuntu:24.04` | Retained upstream recipe; glibc is required |
| Node | `24.21.0` | Retained per-architecture sha256 values in the Dockerfile |
| Bun | `1.4.4` | Candidate `package.json` and OMP package engine require at least 1.4.4; [public release asset digests](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.4) |
| gh | `2.100.0` | Retained upstream version and per-architecture sha256 values |
| agent-messenger | `2.40.0` | [Published npm metadata](https://registry.npmjs.org/agent-messenger/2.40.0), Node >=22.13.0 |
| OMP | f40f3358 / 19.0.1 + `native-omp.patch` | Exact `native-omp.lock` upstream/result identity; frozen official `@oh-my-pi/pi-natives@19.0.1` addon, no Cargo |

Bun's new asset sha256 values are `bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c` for `bun-linux-x64.zip` and `baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e` for `bun-linux-aarch64.zip`. These were read from the release metadata, not guessed or calculated from a substituted package. The other binary hashes are retained from upstream `97d807b`'s recipe; this port has not downloaded those assets or revalidated their bytes.

The current recipe does not install a stock OMP package globally. It prepares the bound native source bundle as the non-root `cataly` user under `/home/cataly/.cache/omp-cataly` and links `omp` to the guarded source wrapper. These are source contracts, not an observed image build or runtime pass.

The native source and official addon use their frozen dependency locks; agent-messenger still has an exact top-level npm version with transitive ranges. The Ubuntu tag and apt packages are not a complete reproducibility lock, so this is not a bit-for-bit reproducible-image claim.

## Build

From the candidate root, after the source verification/review gate:

```sh
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml build
```

The recipe selects `linux/amd64` or `linux/arm64` binary assets through `TARGETARCH`; actual builds on both architectures are still unrun. A native builder or configured cross-architecture builder/emulation is required. Change binary versions only together with their matching architecture hashes. Change OMP or messenger to actual published package versions and review their engine constraints. Rebuild to package new candidate bytes; no remote Cataly ref is involved.

## First run

Use a fresh compose project and empty named volumes for candidate QA. Reusing a Cataly session and its `.omp`/`.cataly` volumes can restore that session's previously recorded monitors when the session is deliberately resumed.

```sh
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml up -d
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml exec cataly bash
```

Inside the container, credentials are supplied only through deliberate interactive setup and persist in volumes:

```sh
gh auth login
# When configuring a separate messenger identity for isolated intake/reply QA:
agent-messenger auth telegram
# Start omp interactively and use /login for the chosen model provider, then exit.
```

No token, provider credential or owner config is built into the image. Do not import production chat/session history for candidate smoke checks. Messenger auth and receiver/presence activation are separate: neither the image nor the installer starts a receiver or presence writer.

For fresh configuration, copy the example only when config is missing:

```sh
test -e ~/.cataly/config.json || cp /opt/omp-cataly/skills/cataly-mode/references/config.example.json ~/.cataly/config.json
```

Edit `defaultCwd`, model settings and hooks for this container. Set messenger hooks only to the isolated QA destination when that QA stage starts. The image links the skill at `~/.agents/skills/cataly-mode` and the extension at `~/.omp/agent/extensions/omp-cataly`.

Clone work repositories into `~/projects`. From the desired project
directory, explicitly start the harness and check its runtime:

```sh
cataly harness up
cataly harness status
```

Follow skill onboarding in the lead before enabling messenger intake. Use
`cataly harness send lead` and `cataly harness observe lead` rather than
starting another lead against the same state.

Expected source behavior: headless starts the lead, duty and loops without a terminal server. Lead/duty run OMP role `cataly`; lanes and the built-in reviewer use `lane`. Skill lanes retain `defaultModel` and explicit `--model`/`agentCommand` overrides; the harness preserves `CATALY_AGENT_CMD` and OMP's model config. `up` itself starts real loops, so it is an isolated runtime QA step, not an image-start behavior.

## State and restart

Named volumes are prefixed by the compose project, so a second `-p` value gets separate state. The former `.omo`/`omo-state` layout is replaced by OMP's own `.omp` volume; no old volume is removed or imported.

- `~/.cataly` (`cataly-state`): config, harness lanes/inbox/receipts/backlog/loops, skill state, process-bound session records and monitor mirrors.
- `~/.omp` (`omp-state`): OMP config, provider auth, sessions and the extension link.
- `~/.config/gh` (`gh-auth`): GitHub auth.
- `~/.config/agent-messenger` (`messenger-auth`): messenger auth.
- `~/projects` (`projects`): repository checkouts and build artifacts.

The source, global packages and `.agents` skill link live in the image. Fresh named volumes inherit the prepared `cataly` ownership and extension link; existing volumes keep their content on rebuild. Runtime processes and live approvals are not durable evidence of resumed work. After a restart run `cataly harness status` and `cataly boot`; only recreate missing harness sessions with `cataly harness up`. Saved OMP sessions can be restored deliberately, retaining roles and recorded monitors. For a native goal restored paused, wait until the user explicitly directs resumption before using `/goal resume`, and confirm the resulting state.

`docker compose restart`, or `down` followed by `up -d` without volume removal, retains named data. Backup and recovery must include all five volumes and the exact candidate/image input. This source port has not exercised recovery or modified the existing source archives.

## Resources and limits

The compose default is 4 CPUs and 8 GB RAM. OMP lanes and their builds need developer-machine resources; size for lane concurrency. Give the Docker data root tens of gigabytes for projects, package caches and build artifacts. The recipe exposes no network ports and shares no host runtime socket. A VM with the same tools and isolated homes can use the same command/state layout without the container layer.

## Maintainer acceptance

Before any build or runtime activation, inspect the compose configuration:

```sh
docker compose -p omp-cataly-candidate -f examples/container/compose.yaml config
```

Expected: the context resolves to this candidate, the Dockerfile is `examples/container/Dockerfile`, all five volumes are project-scoped, and there is no fixed `container_name`/host auth mount.

Build the image:

```sh
docker build --platform linux/amd64 -f examples/container/Dockerfile -t omp-cataly-candidate:headless .
```

Use `--platform linux/arm64` and distinct image tags on an arm64-capable builder to exercise that architecture. A successful build must show verified binary checksums and frozen source-lock installs. Build success alone does not prove OMP/runtime interaction.

For a network-disabled source/CLI smoke, run the following against the default
image. It starts no runtime server and leaves the stopped container available
for inspection.

```sh
docker run --name omp-cataly-source-smoke-headless --network none omp-cataly-candidate:headless /bin/sh -eu -c '
  cd /opt/omp-cataly
  bun --version
  omp --version
  cataly
  cataly harness --help
  cataly-harness --help
  bun src/cli.ts --help
  test -L /home/cataly/.omp/agent/extensions/omp-cataly
  test -L /home/cataly/.agents/skills/cataly-mode
'
```

Expected for the current recipe: Bun 1.4.4+, OMP 19.0.1 from the bound source launcher, skill help including `harness`, complete root help through all three root entrypoints, and existing extension/skill links. No assertion here is an observed pass or a binary-equivalence claim.

Session QA follows first-run setup with synthetic work, an isolated provider
identity and a separate messenger thread/session: inspect role/session records,
active/paused goal readback, approval-held delivery, monitor restoration, the
two harness roles and their two loops, a restart and volume persistence.
Observe an actual intake and reply before claiming messenger compatibility.
These checks do not authorize a production cutover or watcher activation.
