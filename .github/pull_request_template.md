Follow the [ready-for-review requirements](https://github.com/vntrevx/Cataly/blob/main/CONTRIBUTING.md#ready-for-review).
Keep this PR draft/not ready while applicable local evidence is missing. Explain any N/A.
Required remote CI may be pending for review; all three jobs must pass before merge.

## Change

- One concern and reason:
- Related PRs and unmerged dependencies (or none):

## Contract

- Final source/head SHA and target branch/base SHA:
- Owned state/config and defaults (before -> after):
- Compatibility and earlier accepted fences preserved:

## Provenance

- Copied/adapted third-party code or prompt text (or none):
- Upstream URL, file paths, immutable revision and applicable file/component license:
- Destination paths, modifications and retained copyright/permission/modified-copy notice paths:
- Dependency/SDK/ULW changes: component-specific license/notice paths retained in redistributed
  material (or none):
- Concept-only references: source/revision and independently written work (or none):

## Evidence

Use the existing [setup/gates](https://github.com/vntrevx/Cataly/blob/main/CONTRIBUTING.md#run-the-gates)
and [CI workflow](https://github.com/vntrevx/Cataly/blob/main/.github/workflows/ci.yml).
Give actual commands/results and revisions, or links to those runs. Do not relabel carried-forward
or combined partial counts as a full rerun.

For each run, record the source/head and base SHAs, observed native OMP version/source SHA,
ULW base SHA and overlay identity (`patchSha256` and `resultTree`), OS/architecture, exact
command, and actual receipt link or sanitized output. Separate intended pins from identities actually observed; explain unknown
or N/A when an identity was not observed or a component was not exercised. Describe the
runtime/fixture setup and separately label provider/service calls as synthetic, loopback, or
live; a genuine runtime fixture does not prove live-provider behavior. Name unverified
surfaces. Reuse the receipts rather than creating another evidence ledger.
After a relevant source, runtime, or environment change, rerun the affected checks or leave
that surface unverified: an older receipt remains historical evidence, not proof for the new
configuration.

- Bug reproduction before and after the fix (or not a bug):
- Relevant boundary and failure regressions:
- Affected checks rerun after the last code change:
- Full local `bun run ci` on stabilized final content (command and result):
- Required remote jobs on the PR head (run links and results, or pending):
- Changed CLI/native/runtime surface: actual run, isolated state and runtime/host identity (or N/A):
- Performance claim: pinned same-workload baseline/candidate, correctness and relevant time/memory
  results (or no claim):
- Failed/skipped/unrun checks and environment/capability limits, with reasons:

- [ ] Earlier regression coverage preserved; no tests/assertions, skips or timeouts weakened to pass.
- [ ] No credentials, private transcripts, account data or private config in patches, fixtures or evidence.
