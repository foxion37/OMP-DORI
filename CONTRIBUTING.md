# Contributing to omp-dori

This is the contribution guide for [vntrevx/omp-dori](https://github.com/vntrevx/omp-dori).
The fork is maintained by [vntrevx](https://github.com/vntrevx); issues and changes belong here.

## Propose a change

1. Check this fork's [issues](https://github.com/vntrevx/omp-dori/issues) and
   [pull requests](https://github.com/vntrevx/omp-dori/pulls) for related work.
2. Open an issue describing the observed behavior, reproduction and expected result, or a focused
   pull request against `main` with the reason for the change.
3. Develop in an ordinary source checkout using the setup below. Keep credentials, private
   conversations, account data and installed release state out of patches and fixtures.
4. Run the applicable gates below and record the actual commands and results. State any check
   you did not run; include a regression for changed behavior.
5. Preserve source attribution and the license applicable to the material you change.
   Update documentation when the user-facing behavior or setup changes.

## Project credit

omp-dori brings together [dori-superagent](https://github.com/sisyphuslabs/dori-superagent),
[oh-my-pi](https://github.com/can1357/oh-my-pi) and [omp-ulw](https://github.com/dbc-hbin/omp-ulw).
The pre-existing OMP integration retains the YeonGyu Kim and betive37 notices.
Current fork maintenance is credited to vntrevx. Imported revisions and modified-copy provenance
are recorded in [NOTICE](NOTICE); each project's original authors retain their credit.

## Contribution terms

Changes retain the existing license applicable to the affected material: Sustainable Use
License 1.0 for dori-superagent-derived code, and MIT for the pre-existing OMP integration
covered by [LICENSE.omp-dori](LICENSE.omp-dori). See the scope in [LICENSE](LICENSE).
Submit only material you have the right to contribute.

This fork does not require a CLA signature or a CLA comment on its pull requests.
The workflow is restricted to upstream `sisyphuslabs/dori-superagent`; [CLA.md](CLA.md)
is retained as that upstream project's agreement, not a new agreement for this fork.

## Source development and public releases

Consumers follow the [verified release installation and support guide](docs/releases.md) and use `dori update check|install|status|rollback`. Maintainers work in a separate ordinary checkout; the source-only installer is `scripts/install-source.sh`. To install the current checkout beside an existing Dori without pulling, use `DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh`. `OMP_DORI_HOME` selects the side config/state/wrapper home (default `~/.omp-dori`); `OMP_DORI_BIN_DIR` selects the `omp-dori` command destination. The wrappers and `omp-dori-mode` skill keep lanes in that home, with `HC_SESSION=omp-dori` by default (`OMP_DORI_HC_SESSION` overrides it). See the [source installation guide](docs/releases.md#source-checkouts-for-maintainers) for modes, backups and path overrides.

The current source default prepares `native-omp.lock`/`native-omp.patch` and `omp-ulw.overlay.lock`/`omp-ulw.patch`, preserving the upstream ULW commit schema. Use the generated primary `~/.dori/bin/omp` or side `omp-dori omp`, not a stock command on PATH. The official addon package has its own frozen `native-addon/bun.lock`; no Cargo build is required. Read [the bound-source contract](docs/releases.md#current-source-bundle) for source identities, explicit overrides and older release rollback. Changes to these defaults require real isolated installation evidence in addition to source gates.

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

The extension's `with the real omp-ulw` group executes the bound `ref/omp-ulw/index.ts` fixture and retains its existing absent-fixture skip. When it is present, the native guard requires the isolated OMP 18.20.0 host and exact explicit-override compatibility entry; a missing host fails. Prepare the same default overlay and separate legacy override as the Linux/macOS CI jobs:

The extension declares OMP 18.20.0 as a host peer. Its embedded loader import is typed against the genuine
published declarations in the native fixture; a raw source checkout without `dist/types` is not a substitute
for that consumer typecheck. Runtime composition uses the selected host's canonical extension loader and
native settings scope.

```sh
fixture_home="$(mktemp -d)"
bun scripts/source-dependencies.ts ulw "$PWD" "$fixture_home" "$PWD/ref/omp-ulw"
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

The required-source regression also runs genuine SDK sessions through the shared print/RPC runtime initializer and a loopback HTTP provider. Missing managed overlays must send no request for Dori or lane roles, both through normal session prompting and direct agent dispatch; ordinary sessions must still reach the local provider. This catches native handler exceptions being reported and swallowed without cancelling a request. It uses only synthetic local credentials and blocks external catalog access.

The compatibility checkout stays outside the repository (`RUNNER_TEMP` in CI) and selects no production dependency. Its exact `cbfe5ee72e5b2783af01616e7f4d3da5e3f9180d` factory runs alone on the genuine 18.20.0 host to establish the legacy prompt as opaque baseline data. Dori's explicit embedded import must preserve that baseline plus one Sol lane-main bookkeeping block, with unchanged base and stable repeat turns. Dori, ordinary, non-Sol and subagent prompts retain the applicable legacy behavior and role gate; no current model-preset marker or standalone legacy mode is assumed. The current default instead uses b215 plus its bound overlay. This guard does not mutate global model/auth settings or external dependencies, and never authorizes a stock/version-only cache as a source-bundle substitute.

## A pull request

- One concern per pull request, with a title that says what changed and a body that says why.
- Evidence, not adjectives: the command you ran and what it printed, or the file and line you read. A claim you did not verify is written as unverified.
- Tests where behaviour changed; a test that cannot fail is not a test.
- Public surfaces — issues, pull requests, commits, review comments — are English.
- Do not edit another person's work to make your change pass; report it instead.

## Licences and notices

Upstream code remains under the [Sustainable Use License 1.0](LICENSE). The pre-existing OMP integration retains its [MIT notice](LICENSE.omp-dori); this does not relicense upstream code as MIT. [NOTICE](NOTICE) records the modified copy and attribution, and third-party components retain their own licences. Contributions follow the applicable existing licence terms. The upstream [CLA](CLA.md) is retained unchanged and applies to upstream sisyphuslabs/dori-superagent only; this fork does not require a CLA signature.
