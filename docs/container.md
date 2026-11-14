# Maintainer source-container recipe

This maintainer recipe packages **the local source checkout**, including the complete upstream harness, skill, shared runtime adapters and retained OMP extension. It does not clone a separate Dori release. Public consumers should follow the [verified release installer and support guide](releases.md). This recipe's build and session checks are separate evidence, not a published or independently validated consumer image. The first public preview supports Linux x64/herdr/Discord; the retained hc/other-architecture recipe does not expand that live support scope.

The primary `dori` command runs `skills/dori-mode/scripts/src/cli.ts`. `dori harness <args>` dispatches to the complete root CLI; `dori-harness <args>` and `bun /opt/omp-dori/src/cli.ts <args>` also reach it. The image never assigns the root CLI the primary `dori` name.

## Files and build inputs

- `examples/container/Dockerfile`: Ubuntu 24.04, gh, Node, Bun, herdr or hc, agent-messenger, OMP and the local candidate at `/opt/omp-dori`.
- `examples/container/compose.yaml`: one service named `dori`, default project `omp-dori-candidate`, project-scoped named volumes and no fixed container name, published ports or host credential mounts.
- `examples/container/entrypoint.sh`: starts only `herdr server` or `hc server start`, then executes the supplied command (default `sleep infinity`). It starts no OMP session, harness, messenger receiver, presence writer or watcher.
- `.dockerignore`: a source allowlist followed by exclusions for dependencies, nested Git metadata, env/auth files and operator state. Keep credentials and private data outside the source directories even when preparing a local build context.

Compose's build context is the candidate root (`../..` relative to the compose file), with `examples/container/Dockerfile` as its recipe. `COPY . /opt/omp-dori` therefore includes the edited candidate, notices, prompts, tests, extension and full sibling layout. Root, skill and extension dependencies are installed with `--frozen-lockfile`; no host `node_modules` is copied. The source checkout's current bytes, including uncommitted port edits, are the image's Dori input. There is no `DORI_REF` clone or build argument.

| Input | Pinned value | Source of the pin |
|---|---|---|
| Base | `ubuntu:24.04` | Retained upstream recipe; glibc is required |
| Node | `24.21.0` | Retained per-architecture sha256 values in the Dockerfile |
| Bun | `1.4.4` | Candidate `package.json` and OMP package engine require at least 1.4.4; [public release asset digests](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.4) |
| herdr | `0.9.5` | Retained upstream version and per-architecture sha256 values |
| hc (when `HC=1`) | `0.1.18` | Retained upstream version and per-architecture sha256 values; release [manifest](https://releases.herdr.dev/core/0.1.18/manifest.json) |
| gh | `2.100.0` | Retained upstream version and per-architecture sha256 values |
| agent-messenger | `2.40.0` | [Published npm metadata](https://registry.npmjs.org/agent-messenger/2.40.0), Node >=22.13.0 |
| OMP | `@oh-my-pi/pi-coding-agent@18.18.8` | [Published npm metadata](https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/18.18.8), `omp` bin, Bun >=1.4.4 |
| omp-ulw | `d69ad5fbe032c8aa49098c1d599c20df232bc474` | Candidate `omp-ulw.lock`; [public source](https://github.com/dbc-hbin/omp-ulw/tree/d69ad5fbe032c8aa49098c1d599c20df232bc474) |

Bun's new asset sha256 values are `bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c` for `bun-linux-x64.zip` and `baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e` for `bun-linux-aarch64.zip`. These were read from the release metadata, not guessed or calculated from a substituted package. The other binary hashes are retained from upstream `97d807b`'s recipe; this port has not downloaded those assets or revalidated their bytes.

OMP and agent-messenger have exact top-level npm versions and use registry integrity metadata during installation. Their transitive ranges, the Ubuntu tag and apt packages are not a complete reproducibility lock; do not interpret the recipe as a bit-for-bit reproducible image. The public omp-ulw checkout is verified against the lock commit; that revision is TypeScript source without a package manifest and needs no separate package install. It remains outside Dori's license and keeps its own notices.

## Build

From the candidate root, after the source verification/review gate:

```sh
docker compose -p omp-dori-candidate -f examples/container/compose.yaml build
```

The recipe selects `linux/amd64` or `linux/arm64` binary assets through `TARGETARCH`; actual builds on both architectures are still unrun. A native builder or configured cross-architecture builder/emulation is required. Change binary versions only together with their matching architecture hashes. Change OMP or messenger to actual published package versions and review their engine constraints. Rebuild to package new candidate bytes; no remote Dori ref is involved.

### hc instead of herdr

The default image includes herdr. To include hc in its place:

```sh
docker compose -p omp-dori-candidate -f examples/container/compose.yaml build --build-arg HC=1
```

The hc release tarball is checked against `HC_SHA256_AMD64`/`HC_SHA256_ARM64`, installed as `herdr-core` with `hc` beside it, and configured with `notes = false` under `~/.config/herdr-core/config.toml`. Exactly one runtime binary is installed, so an otherwise unset runtime is detected from PATH. An existing config's `runtime` setting still takes precedence over PATH; select `hc` in that config when using the hc image.

The retained extension emits native OSC 7501 `app=omp` in hc role sessions: idle/working from agent lifecycle, blocked during approvals, and unknown when its owned role record is removed. HC unknown remains held and conditional `--if` gates remain intact. OMP 18.18.8 also has a [general OSC reporter](https://github.com/can1357/oh-my-pi/blob/v18.18.8/packages/coding-agent/src/utils/run-status.ts) for interactive TTY output when `terminal.programStatus` is enabled. A file record alone never replaces native status. With herdr, install its bundled OMP integration during first-run setup. See [runtime.md](runtime.md) for both adapters and delivery holds.

## First run

Use a fresh compose project and empty named volumes for candidate QA. Reusing a Dori session and its `.omp`/`.dori` volumes can restore that session's previously recorded monitors when the session is deliberately resumed.

```sh
docker compose -p omp-dori-candidate -f examples/container/compose.yaml up -d
docker compose -p omp-dori-candidate -f examples/container/compose.yaml exec dori bash
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
test -e ~/.dori/config.json || cp /opt/omp-dori/skills/dori-mode/references/config.example.json ~/.dori/config.json
if command -v herdr >/dev/null 2>&1; then herdr integration install omp; fi
```

Edit `runtime`, `leadPane`, `laneWorkspace`, `defaultCwd`, model settings and hooks for this container. Set messenger hooks only to the isolated QA destination when that QA stage starts. The image links the skill at `~/.agents/skills/dori-mode`, the extension at `~/.omp/agent/extensions/omp-dori`, and pinned omp-ulw at `~/.dori/omp-ulw`. The extension's default `ompUlwPath` resolves through that link; an explicit config override remains the operator's choice.

This source-container layout keeps configured dependency paths unchanged. Verified consumer releases resolve their managed `~/.dori/releases/consumer-dependencies/omp-ulw-<commit>` paths against the loaded source's own lock; explicit external paths remain user-owned. See [consumer installation layout](releases.md#installation-layout-and-preserved-data).

Clone work repositories into `~/projects`. For the primary messenger workflow, start `omp --dori-role dori` inside the runtime and follow the skill's onboarding. For a deliberate harness evaluation, from the desired project directory:

```sh
dori harness up
dori harness status
```

Expected source behavior: herdr opens lead/duty and two loop panes; hc opens four labelled terminals. Lead/duty run OMP role `dori`; lanes and the built-in reviewer use `lane`. Skill lanes retain `defaultModel` and explicit `--model`/`agentCommand` overrides; the harness preserves `DORI_AGENT_CMD` and OMP's model config. `up` itself starts real loops, so it is an isolated runtime QA step, not an image-start behavior.

Attach through the selected runtime:

```sh
# herdr image
docker compose -p omp-dori-candidate -f examples/container/compose.yaml exec dori herdr
# hc image: list labels, then pick a terminal (ctrl+\ detaches)
docker compose -p omp-dori-candidate -f examples/container/compose.yaml exec dori hc ls
docker compose -p omp-dori-candidate -f examples/container/compose.yaml exec dori hc
```

## State and restart

Named volumes are prefixed by the compose project, so a second `-p` value gets separate state. The former `.omo`/`omo-state` layout is replaced by OMP's own `.omp` volume; no old volume is removed or imported.

- `~/.dori` (`dori-state`): config, harness lanes/inbox/receipts/backlog/loops, skill state, process-bound session records, monitor mirrors and the link to immutable omp-ulw.
- `~/.omp` (`omp-state`): OMP config, provider auth, sessions and the extension link.
- `~/.config/gh` (`gh-auth`): GitHub auth.
- `~/.config/agent-messenger` (`messenger-auth`): messenger auth.
- `~/projects` (`projects`): repository checkouts and build artifacts.

The source, global packages and `.agents` skill link live in the image. Fresh named volumes inherit the prepared `dori` ownership and extension/omp-ulw links; existing volumes keep their content on rebuild. Runtime processes and live approvals are not durable evidence of resumed work. After a restart inspect the selected runtime and run `dori boot`; only recreate missing harness sessions with `dori harness up`. Saved OMP sessions can be resumed deliberately, retaining roles and recorded monitors, while a native goal may need `/goal resume`.

`docker compose restart`, or `down` followed by `up -d` without volume removal, retains named data. Backup and recovery must include all five volumes and the exact candidate/image input. This source port has not exercised recovery or modified the existing source archives.

## Resources and limits

The compose default is 4 CPUs and 8 GB RAM. OMP lanes and their builds need developer-machine resources; size for lane concurrency. Give the Docker data root tens of gigabytes for projects, package caches and build artifacts. The recipe exposes no network ports and shares no host runtime socket. A VM with the same tools and isolated homes can use the same command/state layout without the container layer.

## MAIN-owned acceptance, all unrun

Before any build or runtime activation, MAIN can inspect the compose configuration and entrypoint syntax:

```sh
docker compose -p omp-dori-candidate -f examples/container/compose.yaml config
sh -n examples/container/entrypoint.sh
```

Expected: the context resolves to this candidate, the Dockerfile is `examples/container/Dockerfile`, all five volumes are project-scoped, there is no fixed `container_name`/host auth mount, and the syntax check exits 0.

Build the two variants separately so both images remain addressable:

```sh
docker build --platform linux/amd64 -f examples/container/Dockerfile -t omp-dori-candidate:herdr .
docker build --platform linux/amd64 -f examples/container/Dockerfile --build-arg HC=1 -t omp-dori-candidate:hc .
```

Use `--platform linux/arm64` and distinct image tags on an arm64-capable builder to exercise that architecture. A successful build must show verified binary checksums, frozen source-lock installs and the locked omp-ulw checkout. Build success alone does not prove OMP/runtime interaction.

For a network-disabled source/CLI smoke that starts no runtime server, MAIN can run the following against each built tag, with a distinct container name for each. It leaves the stopped container for explicit resource cleanup rather than removing it automatically.

```sh
docker run --name omp-dori-source-smoke-herdr --network none --entrypoint /bin/sh omp-dori-candidate:herdr -eu -c '
  cd /opt/omp-dori
  bun --version
  omp --version
  dori
  dori harness --help
  dori-harness --help
  bun src/cli.ts --help
  test -L /home/dori/.omp/agent/extensions/omp-dori
  test -L /home/dori/.agents/skills/dori-mode
  test "$(git -C /opt/omp-ulw rev-parse HEAD)" = "$(cat omp-ulw.lock)"
'
```

Expected: Bun 1.4.4, OMP 18.18.8, skill help including `harness`, complete root help through all three root entrypoints, existing extension/skill links and the lock-matching omp-ulw commit. Repeat using `omp-dori-candidate:hc` and name `omp-dori-source-smoke-hc` for the hc image. No assertion here is an observed pass.

Actual session QA then follows first-run setup with synthetic work, an isolated provider identity and a separate messenger thread/session: inspect role/session records, active/paused goal readback, approval-held delivery, monitor restoration, all four harness sessions, a restart and volume persistence. MAIN must observe one benign intake/reply before claiming messenger compatibility. No production cutover or production watcher activation is implied by these steps.
