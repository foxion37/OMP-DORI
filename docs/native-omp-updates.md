# Native OMP release candidates

Native updates use a two-job trust boundary: preparation has no publication token; a fresh trusted publisher proposes a draft, never merges it. The native workflow is [`native-update.yml`](../.github/workflows/native-update.yml), restricted to `vntrevx/Cataly`, scheduled at 03:30 UTC (12:30 KST, subject to GitHub scheduling delays).

## Prepare and review

From a clean, committed Cataly checkout:

```sh
bun scripts/update-native-omp.ts --out /absolute/new-candidate-directory
```

Preparation reads stable semantic-version tags from `can1357/oh-my-pi`, selects the highest version numerically, and binds annotated tags to their peeled commit. Prereleases are ignored; ambiguous tags, moved same-version tags, downgrades, dirty source, and changed package/tag identities stop preparation. The original source, installed caches, and live homes are not changed.

The bound old overlay is first verified against its exact upstream commit, normalized into a full-index binary patch, then applied with `git apply --3way --index` in a private checkout. An ancestry check rejects unrelated release histories. No upstream build or lifecycle script runs during preparation.

Stable `19.x.y` releases can become draft candidates. A new major is held for a reviewed runtime-protocol port instead of being admitted through a metadata-only bump. Required package stamps are part of each candidate:

| Files | Purpose |
| --- | --- |
| `native-omp.lock`, `native-omp.patch` | Upstream commit, version, launcher, patch digest, result tree, exact postimages |
| `native-addon/package.json`, `native-addon/bun.lock` | Exact official addon matching the native version |
| `extension/package.json`, `extension/bun.lock` | Exact extension peer host |
| `test/fixtures/omp-native-host/package.json`, `test/fixtures/omp-native-host/bun.lock` | Exact genuine host used by CI |

Only these eight files can enter an automatic draft. Source-native version guards and CI derive their version from the native lock rather than requiring arbitrary source edits. The preparer copies the trusted package manifests and existing locks into private directories, changes only the selected exact pin, and resolves new text locks with `bun install --ignore-scripts --lockfile-only` against npm. Missing packages, registry failures, unexpected lock shape, or a failed lock refresh produce a held artifact, not an unbuildable metadata-only draft.

The fresh publisher uses the exact trusted Cataly commit recorded before preparation. It validates all artifact entries, sizes, receipts, native identities, exact package-pin changes, and npm-only frozen locks before using its write token. Artifact files are data: no candidate source, package command, Git hook, or patch runs in this job. Unknown paths, symlinks, extra receipt fields, forged digests, and unexpected package sources are rejected.

Publication holds if `main` has advanced. An existing branch is reused only after proving its single exact source parent and complete fixed-file delta; changed branches are never overwritten. Repeated publication reuses an exact open or closed PR. New drafts dispatch `ci.yml` only after checking that the branch still names the expected head; the publisher does not repeat an already observed dispatch for that head. Explicit dispatch avoids relying on automatic `GITHUB_TOKEN` PR event behavior; [GitHub documents the workflow dispatch exception](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

Textual application is not compatibility approval. Review `check` on the proposed head and actual combined target content, release notes, attribution, isolated installation, and lane/monitor/ASK/voice behavior before merging. Branch movement after dispatch or a later `main` change requires fresh exact-content evidence. No automatic approval, merge, tag, release, consumer pointer, or installation update is performed.

## Conflicts and holds

Failed three-way application writes `candidate.json` and `conflicts.patch` into the `native-candidate` Actions artifact. The patch preserves Git's unresolved combined diff, including exact conflict-marker hunks; if Git fails before producing an unresolved diff, the complete normalized overlay is retained instead. There is no conflict-resolution model, retry with another merge strategy, or automatic hunk deletion.

Unsupported-major, missing launcher/CLI layout, and dependency-refresh holds retain the exact original overlay in the same artifact format, with distinct reason codes. The trusted publisher creates a canonical reviewed-port issue containing the source/upstream identities, reason, artifact link, and SHA-256. Repeated publication reuses the issue keyed by upstream commit and previous native identity. Artifacts are retained for 30 days; preserve them as review evidence before expiry. A held run does not create a candidate branch or dispatch candidate CI.

To capture a manually reviewed, already staged port:

```sh
bun scripts/update-native-omp.ts \
  --checkout /absolute/reviewed-native-checkout \
  --commit EXACT_40_CHARACTER_UPSTREAM_COMMIT \
  --version 19.0.1 \
  --source /absolute/cataly-checkout
```

This mode verifies the checkout's exact `HEAD`, package version, index tree, tracked bytes, and launcher before writing the native lock and patch. It neither stages files nor resolves conflicts. Package/fixture pin updates and the full isolated gates remain necessary for a manual port.

## What "conflict-free" can mean

Automatic three-way replay can avoid repetitive manual work when upstream changes do not overlap the overlay. It cannot guarantee conflict-free upgrades, and a clean apply cannot establish semantic compatibility. The structural way to eliminate patch conflicts is to remove every downstream source hunk, not to automate conflict resolution.

The migration plan is:

1. Use the [versioned native port table](native-omp-19.md#every-remaining-hunk) as the inventory. Submit the [draft general fixes](native-omp-19.md#structural-reduction-and-upstream-candidates) and their native regression tests upstream as separate reviewable patches: workspace-tree invalidation, eval/session-transition kernel ownership, grep pagination, todo validation, and browser todo rendering belong in upstream behavior rather than a Cataly-only fork. Keep each overlay hunk until the exact selected release contains its accepted equivalent.
2. Keep Cataly role policy, prompt composition, required-source admission, and manager-tool authorization in the existing extension/configuration boundaries. Migrate a retained hunk only when a public OMP hook can reproduce its behavior and ordering; retain the real-host regressions. An extension wrapper that silently changes native error, disposal, or session-transition behavior is not an equivalent replacement.
3. Regenerate viewer metadata only from the reviewed source when a retained frontend change requires it. Generated hashes are not independent customization and must not be guessed or copied across releases.
4. After each accepted upstream fix or proven hook migration, remove that exact overlay hunk and its duplicate downstream implementation, then regenerate identities and run the native gates. The empty-overlay case deliberately holds for a reviewed stock/no-overlay protocol migration.

The target is a small extension/configuration surface plus upstreamed native fixes. Until the source overlay is empty, automatic preparation remains best-effort and conflicts remain explicit reviewed work.

## Stock external OMP as the default

Selecting an external OMP for an opt-in lane is not evidence that the bound default can be replaced. The current release protocol authenticates a native source tree, official addon, launcher, Bun identity, and export assets; source and consumer installation deliberately preserve those receipts. Stock version strings alone do not attest these capabilities.

Before changing the default, the following prerequisites are still required:

- Upstream releases must contain the retained correctness fixes, or public extension/session hooks must reproduce them with the same native regressions. Internal eval-kernel lifecycle ordering cannot be assumed replaceable by a prompt hook.
- Stock OMP plus the Cataly extension must pass the real prompt/load-order, required-source denial, manager-tool, compaction/handoff, and provider-free SDK/RPC checks without relying on patched source.
- An explicit stock-runtime identity and install/update/rollback protocol must replace source/addon receipts without weakening existing retained releases. Discovery must select the intended executable, extension, profile, state home, and daemon/session identity rather than any same-version binary on `PATH`.
- Isolated installation, headless and Tern lanes and monitors, ASK, voice, messenger recovery, export, and matched startup/memory measurements must establish parity on the stock default. Provider-backed behavior needs separately authorized evidence; synthetic transport tests are not that evidence.

These are release prerequisites, not claims that the external stock path is complete. This workflow does not change the default runtime.

## Validation

The new local regressions use real Git repositories for source/patch/tree boundaries and an in-memory GitHub transport for publication. Synthetic npm records test pin/lock admission, not registry package availability, native addon loading, or live GitHub permissions.

```sh
bun test test/native-update*.test.ts test/source-bundle-update.test.ts
```

Then prepare the genuine fixtures and run the full [`CONTRIBUTING.md`](../CONTRIBUTING.md#run-the-gates) gates once the complete branch is stable. A local candidate test is not a workflow publication, compatibility review, or installation smoke receipt.
