# Changelog

## Unreleased

- Discord owner intake carries reply context and ordered attachment metadata, including exact signed URLs and voice flags/duration, through the existing REST/Gateway path. The `INBOUND discord` grammar stays unchanged; following `INBOUND_REPLY`/`INBOUND_ATTACHMENT` records share one emit before cursor commit. Malformed attachments and failed delivery leave the message uncommitted; metadata delivery starts no transcription.
- Discord operations resolve channel names within `DORI_DISCORD_GUILD_ID`, send/edit directly in threads, create text threads or tagged forum posts, rename/retag/archive/reopen threads, and add/remove bot reactions. HTTP(S) audio transcription uses the existing hook with private temporary downloads and cleanup; existing local transcription and the primary Discord intake remain unchanged.
- GPT-6.1 Sol lane main agents receive idempotent guidance to batch required todo, goal and launch-footer bookkeeping with work when dependencies allow. Existing journals, forwarding guards and completion prerequisites remain required; strict review lanes without a launch footer keep their output contract. Other models, Dori, ordinary sessions and subagents retain their prompts.
- Launch footers use the runtime already selected by `DORI_RUNTIME`, config or detection. With a known runtime and lead pane, one shell call records and forwards the report as one data argument after the live-agent/empty-input checks. Missing destinations leave a report-only command and explanatory prose; write-free previews need no running or installed runtime.
- Opt-in `dori inbound discord --gateway` delivers owner text live with REST backfill before queued dispatches after every READY/RESUMED. Both paths share a per-channel cursor for deduplication and ascending delivery. Gateway mode ignores `--loop`, including `0`; default single-channel REST polling, output and cursor files remain compatible.
- Discord intake accepts multiple configured channels and threads through `DORI_DISCORD_CHANNEL_IDS`, with accurate per-variable env diagnostics. Opt-in `DORI_DISCORD_SCOPE=all` discovers readable text channels, active threads and the owner DM, skipping unavailable discovered targets, including DM creation returning 403/404. Explicit-channel, authentication, rate-limit and server failures retain their error behavior.
- Every channel without a saved cursor baselines existing history, including later REST discoveries. In scope `all`, the first live message from an unseen channel starts its cursor just before that message; earlier history is skipped.
- Local inbound response faults, including malformed successful JSON, stop the Gateway backfill queue without advancing past undelivered messages. Real HTTP 502/other 5xx, 429 and network failures remain transient; other HTTP 4xx remain fatal. Gateway shutdown drops queued dispatches, clears retries and drains active REST work before `done` settles, retaining any failure from that work.
- Discovered Discord channels are skipped only for remote history-read 403/404 responses. Missing owner content, delivery failures and local cursor errors propagate instead of being mistaken for lost access. Gateway intake fails on a disappeared watched cursor without silently dropping messages or rebaselining, while new scope-all channels retain first-message seeding.
- The shared Discord Gateway client retains presence behavior and output; intake and presence still own separate sessions and lifecycles. Offline benchmark tooling compares the immutable pre-Gateway single-channel intake with current REST/Gateway variants over synthetic loopback HTTP/WebSocket traffic, not real Discord service latency.
- Lane briefs retain the newest 12 eligible global standing rules and 8 repo lessons under separate caps. Over-cap rules are returned as `omitted` and named in launch warnings with `global` or the canonical repo cwd.
- Nested OMP runs preserve another live process's pane record. Positive safe-integer pid validation allows malformed and dead records to be replaced while retaining live-owner and `EPERM` protection.
- Telegram plain-text sends split losslessly at a conservative 4096 UTF-16 code-unit bound without cutting surrogate pairs, returning the last part's message ID. Malformed API responses stop the send with a messenger error.
- Telegram edits remain single-message updates: oversized raw input fails before any request or mutation. Rich sends retain one unsplit HTML request; rich edits count markup in the same conservative bound. HTML-aware splitting and multi-message edits are outside this change.
- Telegram owner intake retains message dates, adds a single read-receipt reaction for new messages and records lag separately from the positional `INBOUND` line. New lag journals use mode `0600` and contain chat/user metadata, without message text or bot tokens. `inbound-lag --limit` reads backwards to the requested nonblank-record window and reports nearest-rank percentiles, skipping unusable readings.
- Move the maintained source checkout's `omp-ulw.lock` to `d69ad5fbe032c8aa49098c1d599c20df232bc474` for OMP's `⁂` prompt sections while retaining the OMP 18.18.8 minimum. This source change does not replace the published `v0.1.2` assets or their dependency lock.
- Pass an optional provider-capable model through the extension's FakePI context. The real-d69 regression uses an isolated, exactly locked OMP 18.18.8 host and its native factory loader/runner in both existing Linux/macOS test jobs. It checks the combined preset/bookkeeping result across import and standalone orders, declining handlers, base preservation, repeated turns and excluded roles/models/subagents. The existing real-fixture skip applies only when d69 is absent; a present d69 with a missing host fails. The native fixture makes no provider calls and changes no root/consumer dependency or installer pin. See [the fixture requirements](CONTRIBUTING.md#run-the-gates).
- Native composition coverage also compares the exact public `cbfe5ee72e5b2783af01616e7f4d3da5e3f9180d` explicit embedded override against its own opaque legacy baseline. Its compatibility checkout is CI-only under `RUNNER_TEMP`; no legacy source is read locally, no current preset marker is assumed, and production registration order, external paths, config and pins are unchanged by this guard.
- The source-only `scripts/install-source.sh` supports explicit `primary` and `side` modes. Side installs use their own config/state, `omp-dori` wrappers, OMP skill overlay and hc namespace without replacing the primary Dori's command or links; the mode marker keeps reinstalls in place.
- Source installation preserves unmanaged legacy/fork recognition, terminal choice and EOF holds, foreign-checkout and failed-pull guards, and config/link-target backups for explicit unmanaged primary takeovers.
- Primary source installation links the executable skill CLI directly in `OMP_DORI_BIN_DIR` instead of using Bun global package registration. It backs up foreign command symlink targets before replacement and preserves conflicting regular files with an actionable error.
- Consumer release metadata and source pointers protect the selected installation home in either mode, including symlink aliases. Primary source installation holds on a consumer home; side paths must be separate. The consumer bootstrap, release runtime and published release dependency pins are unchanged.
- Source-only omp-ulw defaults to latest `main` on OMP 18.19+, with an implicit lock fallback on older supported OMP and explicit repo/ref/checkout overrides. Existing custom checkouts and pre-package.json standalone extensions are reused; a later standalone removes only the source home's own default link.
- Source configs use an empty `ompUlwPath` so OMP loads the dependency once. Primary source installs disclose global omp-ulw behavior; side wrappers load both extensions explicitly without global discovery, and retain external checkout choices across reinstalls. Consumer nonempty import behavior and verified manifest pins stay intact; source fixtures and container builds continue to follow `omp-ulw.lock`.
- Side source installs can return from a retained external omp-ulw checkout to the existing managed default. Equivalent default paths in legacy configs stay managed, so later installs continue to select and update refs.
- Multi-cycle real-Git publication integration tests use a test-local 30-second budget instead of Bun's 5-second default. Producer timeouts, CI wait deadlines, assertions and retry policy are unchanged.
- Installer regression fixtures cover data/permission/link preservation and managed consumer isolation. The new source workflow has no new real OMP, provider, messenger, consumer QA or CI result claimed here; those results belong with the exact candidate's evidence.

These source changes retain the existing consumer release interfaces and minimum requirements; source dependency policy and pin changes are described above. The published preview's live support boundary is unchanged.

## 0.1.2 — Linux x64 preview (`v0.1.2`)

This preview targets the first public release for the OMP port. Live consumer support is scoped to Linux x64, herdr and Discord. The tested clean-consumer baseline is Ubuntu 24.04 x64 with Bun 1.4.4, native OMP 18.18.8 and herdr 0.9.5; Bun and OMP versions are also the minimum requirements. Newer versions, other Linux distributions, macOS, hc and other messengers do not inherit an unperformed live consumer test from that baseline. See the [installation and support guide](docs/releases.md) for the support boundary and the canonical release path.

### Superseded unpublished tags

`v0.1.0` was tagged before the producer identity correction but was never published and has zero uploaded assets. A body-only draft metadata update changed the draft's tag binding, so publication verification stopped before any asset upload.

The immutable `v0.1.1` tag points to `6ff348fc247bfa7c36df8a11b86d2cc0b4d80c92`. Its official build and gate passed, and canonical draft identity survived, confirming the initial identity fix. Publication then stopped on the first asset upload, `SHA256SUMS`; its underlying HTTP error was not retained. The binary upload helper omitted required `Content-Length`, and a separate real API diagnostic reproduced HTTP 400 for that lengthless request. That release was never published and has zero release assets.

Both tags are retained immutably as superseded unpublished release attempts, not stable published releases. `v0.1.2` is the new intended first public preview.

### Producer corrections

The producer now names the tag and commit identity explicitly in every release-metadata mutation, including the release-update path that previously sent only the body, and reads back the known release ID instead of re-resolving a draft by tag. This is a producer interface change; consumer commands and the asset contract are unchanged.

Binary release-asset uploads now set the exact `Content-Length` from the existing payload's `byteLength`, without another copy or read. The stateful upload fixture rejects missing, malformed or mismatched lengths against the actual stdin bytes with HTTP 400; the existing complete producer lifecycle is the regression case.

The corrected upload and download helpers were exercised against GitHub with one private binary test asset, including a byte-offset view and SHA-256-verified binary readback. Only that newly created test asset was deleted afterward; the held draft's tag, body and zero-asset state were preserved. This proves the binary transport, not publication of a consumer release.

CLI output, release metadata and opt-in telemetry resource versions use the canonical root `package.json` version rather than independent copied version values.

### Release installation and recovery

- The root `install.sh` installs an exact verified release instead of cloning or pulling arbitrary `main`. Select this preview explicitly with `--version v0.1.2` or `DORI_RELEASE=v0.1.2`; default latest selects stable releases only.
- Fixed assets are `omp-dori-v0.1.2.tar.gz`, `release-manifest.json`, `SHA256SUMS` and `install.sh`. Version/tag, commit/tree, archive digest and the extracted public source manifest are checked before activation. Unsafe archive paths, links and special files are rejected.
- The explicit launcher is `~/.dori/bin/dori`. CLI, skill and extension use one active `~/.dori/src` pointer, with verified previous releases retained for rollback. Existing configuration, authentication, work and sessions are preserved.
- `dori update check|install|status|rollback` is the consumer release API. `--version` selects an exact release; `check` and `install` also accept `--from DIST` for local assets. First-time pinned public omp-ulw retrieval can still require anonymous network access.
- Consumer-managed dependency cache paths resolve from the executing release's own `omp-ulw.lock`, including after update or rollback, without rewriting saved configuration. Explicit dependency paths outside that managed cache remain user-owned.
- Dead updater lock recovery retains an identity-bound tombstone, so a delayed concurrent contender cannot steal a newly acquired live lock.
- Install/update/rollback activation holds while a live Dori exists, even when idle. These commands do not kill or restart sessions. Failed verification keeps the prior source active; rollback verifies the retained previous release. The activation journal supports interrupted pointer/state reconciliation.
- Installation starts no provider, messenger, watcher, service, presence process or harness. Users supply their own AI and messenger authentication; consumer release management needs no porting models, `gh` or GitHub write permission.

### Maintainer interfaces

- Existing source-port/check/fresh-review, promotion, supervisor and recovery functionality moves to `dori upstream ... --config FILE`. There is no legacy `dori update stage/watch` alias.
- The checkout installer moves to `scripts/install-source.sh`, retaining its source-user behavior. Public consumers use the separate release bootstrap.
- `bun scripts/release.ts build --out DIST --prerelease` packages actual committed source into the fixed release assets. The root `package.json` remains the canonical version source; public archives exclude `ref/omp-ulw` and keep the exact external dependency pin.
- Tag publication requires successful exact-commit `check`, `test-macos`, `e2e-herdr` and `e2e-hc` results from the repository's trusted CI workflow and GitHub Actions app. Existing tags/releases/assets are not overwritten.

### Discord operation

Native `dori inbound discord` provides owner-only bot REST intake for one exact channel, with required bot token/owner/channel environment and a persistent per-channel cursor. Its default polling interval is three seconds; `--loop` remains minutes, with `0` for one-shot operation. A cold start records the latest message without replaying history; resumed polling emits new owner text chronologically. Startup checks authentication, channel access and Message Content Intent. The supported text flow needs no Node, external agent-messenger watcher, private helper or ad-hoc SDK adapter. Both intake and presence remain explicit native-monitor opt-ins, with the token loaded only inside each child from the user's protected file.

Discord REST polling and message sending are separate from online presence. An explicitly enabled `dori presence discord` process must remain running under the owning OMP session's native monitor supervision to keep the bot online. Readiness follows a genuine Gateway READY/RESUMED dispatch, the first heartbeat acknowledgement of each connection is logged, and reconnect/terminal errors are distinguished from readiness. Later routine acknowledgements update lifecycle state silently. Explicit stop ends the presence lifecycle and makes the bot offline; installation does not silently enable it or restore unrelated paused watchers.

### Retained source features and verification limits

The port retains messenger/lane commands, host and heavy-slot guards, claim-done evidence checks, worklog/checkpoints/lessons, the complete lead/duty harness, duty/hourly loops, inbox/backlog, runtime migration, review/merge gates, hooks and telemetry. OMP roles, live-process session identity, approval-aware delivery, native goals and recorded monitor intent remain part of the runtime integration. Slack, Telegram and hc source features remain available to maintainers.

CI coverage for macOS/hc is distinct from supported live consumer behavior. A source test, isolated runtime fixture, clean install/recovery run and actual messenger intake/reply establish different things. This changelog is not a claim that a future QA run passed, a model/provider was exercised, an independent external-user beta took place or an asset was published. Actual release QA, exact-head CI and publication readback belong with that release's evidence.

The terminal-admission integration group uses a test-local 20-second budget for two distinct real Git/fsync candidate lifecycles. Runtime command deadlines, assertion coverage and the default budget of unrelated tests are unchanged.

The Sustainable Use License, OMP attribution in `LICENSE.omp-dori`, `NOTICE`, public dependency pin and third-party notices remain unchanged.
