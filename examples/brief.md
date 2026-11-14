# Lane brief: fix-flaky-login

Harness example for the OMP candidate: open it with `dori harness start fix-flaky-login --brief examples/brief.md` (or `bun src/cli.ts start ...` from the candidate root). The implementation session uses OMP role `lane`; lead/duty use `dori`. Read the generated lane footer and create the native OMP goal from this brief.

Goal: the login test in tests/auth/login.test.ts fails about 1 run in 20. Find why and fix the cause, not the symptom.

Inputs: CI runs of the last week; the test file; src/auth/session.ts.

Deliverable: one PR that fixes the root cause, with a test that fails before the fix and passes after.

Stop condition: the PR is open, its checks are green, and you have sent READY with the PR link using `dori harness ready fix-flaky-login --text "root cause fixed; checks green" --evidence https://github.com/owner/repo/pull/12` (substitute the actual resulting PR). The generated footer also supplies the absolute root CLI entrypoint. This harness READY protocol is separate from a skill lane's `dori claim-done`/`dori close`.

Constraints: no retries or longer timeouts as the fix; do not touch unrelated tests.
