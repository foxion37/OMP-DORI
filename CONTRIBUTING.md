# Contributing

Thanks for looking. This repository is a small, strict codebase; a change lands when it is one concern, it has evidence, and every gate is green.

## Upstream CLA process (sisyphuslabs/dori-superagent only)

The CLA process below belongs to upstream [sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent) and is kept here as attribution. This fork's CLA workflow is intentionally disabled: the CLA Assistant job in `.github/workflows/cla.yml` runs only when the repository is `sisyphuslabs/dori-superagent`, so it never runs for pull requests to this fork, and signing comments are not required for PRs to this fork. [CLA.md](CLA.md) is retained unchanged as the upstream legal text.

For reference, the upstream process is: every contributor signs the [Contributor License Agreement](CLA.md) once, before a pull request of theirs can be reviewed or merged there. Comment on the pull request with exactly:

```
I have read the CLA Document and I hereby sign the CLA
```

The CLA Assistant workflow then records the signature and the check turns green; it never asks again. Signing is what lets upstream keep one licence for every contribution, including the relicensing rights it needs when it changes its licence — the [licence](LICENSE) is the Sustainable Use License, and the CLA is what makes future licence changes possible without hunting down every author.

## Source development and public releases

Consumers follow the [verified release installation and support guide](docs/releases.md) and use `dori update check|install|status|rollback`. Maintainers work in a separate ordinary checkout; the source-only installer is `scripts/install-source.sh`. To install the current checkout beside an existing Dori without pulling, use `DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh`. `OMP_DORI_HOME` selects the side config/state/wrapper home (default `~/.omp-dori`); `OMP_DORI_BIN_DIR` selects the `omp-dori` command destination. The wrappers and `omp-dori-mode` skill keep lanes in that home, with `HC_SESSION=omp-dori` by default (`OMP_DORI_HC_SESSION` overrides it). See the [source installation guide](docs/releases.md#source-checkouts-for-maintainers) for modes, backups and path overrides.

Consumer control metadata and the managed source pointer protect the selected installation home in both modes, including aliases: `primary` source installation holds on consumer-managed `~/.dori`, and `side` requires a separate destination. An unmanaged source home retains the existing primary workflow; another unmanaged Dori prompts in a terminal or holds without one unless a mode is explicit. Do not develop inside a frozen installed release. Source fixture checks, real OMP wrapper/skill isolation and provider or messenger QA are separate evidence; this change claims no new live QA.

Upstream porting and candidate/recovery operations use `dori upstream ... --config FILE`. That interface can use configured models and maintainer publication permissions; consumer release management uses neither. Build fixed public assets with `bun scripts/release.ts build --out DIST --prerelease`, then follow the [exact-commit review/QA/CI/tag publication procedure](docs/releases.md#building-and-publishing-releases). Source checks, real runtime/messenger evidence and independent external-user testing are distinct claims.

## Run the gates

```sh
bun install --frozen-lockfile
(cd skills/dori-mode/scripts && bun install --frozen-lockfile)
(cd extension && bun install --frozen-lockfile)
(cd test/fixtures/omp-native-host && bun install --frozen-lockfile)
export DORI_TEST_OMP_ROOT="$PWD/test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent"
bun run ci
```

`bun run ci` is the same chain CI runs:

- `check` — Biome lint and format.
- `typecheck` — `tsc --noEmit` for the harness, skill scripts and extension, run concurrently.
- `knip` — no unused files, exports or dependencies.
- `lint:loc` — the TypeScript file-length gate, with a 250-line limit per capped file.
- `test:ci` — the harness suite in two isolated Bun worker processes.
- `test:skill` — the skill's script suite.
- `test:extension` — the OMP extension suite.

`bun run test` remains the sequential harness command for debugging. Linux CI uses `test:ci` with two isolated Bun file workers; the macOS 15 ARM job runs `bun test --parallel=3 --timings=.bun-test-timings.json ./test/` with three. These use native `--parallel` file workers, not `--concurrent`: tests within each file remain sequential, and each file has an isolated global/module registry. The explicit worker limits avoid scaling subprocess-heavy tests to every available CPU. Test discovery, timeouts and the four required CI job names are unchanged. A same-run macOS ABBA comparison (2, 3, 3, 2 workers) observed identical results and lower root-suite time with three workers; two samples per setting are not a guarantee against timing flakes.

`.bun-test-timings.json` holds measured per-file durations used as scheduling hints. They are intended to start slower files earlier and reduce worker imbalance; their effect on idle time and suite runtime has not been measured. A file missing from the manifest is still run; it only loses its ordering hint, so the file is a performance hint, never a coverage gate. Regenerate it whenever the suite's shape changes enough to matter:

```sh
bun test --parallel=1 --timings=.bun-test-timings.json --update-timings ./test/
```

The Linux herdr E2E installer uses the pinned REST release asset and verifies its SHA256 before atomically replacing the binary. Each download attempt is capped at 60 seconds (plus a 5-second termination grace); at most three attempts run, with 20/40-second backoff. A checksum failure fails immediately. The hc job requires its E2E file to exist; a missing file is an error, not a successful skip. These controls keep all four release gates mandatory and do not change macOS coverage or queue capacity.

The unit suites need `bun` and `git` and use recorded stand-ins for `herdr` and `gh`. `test/e2e.test.ts` starts a real `herdr` server and is skipped when `herdr` is not on `PATH`.

The extension's `with the real omp-ulw` group executes `ref/omp-ulw/index.ts` and skips when that file is absent. Its native guard requires both the isolated OMP 18.18.8 host and the exact explicit-override compatibility entry; a missing fixture fails rather than adding a skip. Prepare the host and both dependency revisions as the standard CI `check` and `test-macos` jobs do:

```sh
pin="$(tr -d '[:space:]' < omp-ulw.lock)"
git clone --quiet https://github.com/dbc-hbin/omp-ulw.git ref/omp-ulw
git -C ref/omp-ulw -c advice.detachedHead=false checkout --quiet "$pin"
test "$(git -C ref/omp-ulw rev-parse HEAD)" = "$pin"
compat_pin=cbfe5ee72e5b2783af01616e7f4d3da5e3f9180d
compat="$(mktemp -d /tmp/omp-dori-compat-ulw.XXXXXX)"
git clone --quiet --no-checkout --shared "$PWD/ref/omp-ulw" "$compat"
git -C "$compat" fetch --quiet --no-tags https://github.com/dbc-hbin/omp-ulw.git "$compat_pin"
git -C "$compat" -c advice.detachedHead=false checkout --quiet "$compat_pin"
test "$(git -C "$compat" rev-parse HEAD)" = "$compat_pin"
export DORI_TEST_COMPAT_ULW_ENTRY="$compat/index.ts"
(cd test/fixtures/omp-native-host && bun install --frozen-lockfile)
export DORI_TEST_OMP_ROOT="$PWD/test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent"
bun run test:extension
```

Fixture preparation needs network access unless the exact packages are already available. Confirm that the real-fixture tests ran without being skipped: role gating and native Sol composition must execute. The guard invokes the real OMP `loadExtensionFromFactory` and `ExtensionRunner.emitBeforeAgentStart`, asserting on the combined result, not FakePI's per-handler returns. It covers an imported dependency and both standalone extension orders, retains one model preset, one bookkeeping block and downstream context, replaces the host role, leaves the base untouched and stays stable across repeated turns. A final declining handler must preserve the earlier winner; excluded roles, models and subagents leave the prompt they receive unchanged. A fail-on-access model registry and forbidden action callbacks prevent auth, provider and unrelated work. The private fixture package and its lock are test-only: root/consumer dependencies, model defaults and installer pins are unchanged. These checks do not establish live TUI, messenger or provider behavior; no performance gain is claimed.

The compatibility checkout stays outside the repository (`RUNNER_TEMP` in CI) and does not select a production dependency. Its exact `cbfe5ee72e5b2783af01616e7f4d3da5e3f9180d` factory runs alone on the genuine native host to establish the legacy prompt as opaque baseline data. Dori's explicit embedded import must preserve that baseline plus exactly one Sol lane-main bookkeeping block, with unchanged base and stable repeated turns. Dori, ordinary, non-Sol and subagent prompts are compared with the applicable legacy behavior; ordinary sessions retain the existing role gate. The guard assumes no current model-preset marker in that legacy revision and promises no standalone legacy mode. Configured external dependency paths, global model/auth settings and consumer pins remain untouched.

## A pull request

- One concern per pull request, with a title that says what changed and a body that says why.
- Evidence, not adjectives: the command you ran and what it printed, or the file and line you read. A claim you did not verify is written as unverified.
- Tests where behaviour changed; a test that cannot fail is not a test.
- Public surfaces — issues, pull requests, commits, review comments — are English.
- Do not edit another person's work to make your change pass; report it instead.

## Licence

The project is licensed under the [Sustainable Use License](LICENSE), with third-party components under their own licences. By contributing you agree your contribution is licensed under the same terms. The upstream [CLA](CLA.md) is retained unchanged and applies to upstream sisyphuslabs/dori-superagent only; this fork does not require a CLA signature.
