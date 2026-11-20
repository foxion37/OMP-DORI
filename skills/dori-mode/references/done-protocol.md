# Lane done protocol

Give this file to every lane you launch.

Claiming Done can cause the watcher to close your tab and remove your worktrees. Claim only when the owner has authorized that cleanup, your `Done =` signals read back live, and your worktrees contain no uncommitted or unpushed work. The signals might be a PR merged, an issue closed or a version published. For local or QA-only work they can also be a command that passes, a file with the expected content, or a URL that answers (see `sessions.md`). If cleanup is not authorized or work must be kept, report the result without claiming Done; authorized parking retains worktrees and does not produce a Done receipt.

```sh
dori claim-done <your-lane-key> --evidence "report:<id>; <shareable live Done receipts>"
```

The key is in your brief's lane footer. If you leave it out, the lane registered for your pane is used.

Persist the final report through the existing `report` command, using the footer's five lines: Outcome, Changes/findings, Verified, Unverified, and Handoff. Separate the requested result from observed checks and checks not run; give reasons and unresolved uncertainty rather than fabricated test names or empty placeholders. Investigation-only work reports findings and source evidence, not invented code changes. A partial result uses `milestone`, a blocker uses `blocker`, and cancellation uses `halted`; none is a completion claim. Use `done` only for completed work whose entire `Done =` condition reads back live. A `done` report does not authorize `claim-done`; the cleanup and worktree requirements above still apply.

Record the report once with `report --json`, regardless of whether you can forward it. Match the receipt to `progress.lastReport` from `status <your-lane-key> --json`, or find the exact entry in the configured `reports.jsonl` if a newer report is current. Use the receipt's `id` in the claim. The watcher passes claim evidence to the thread completion hook, so include only the report ID and shareable evidence of live Done signals, such as a merge SHA or version. Keep the journal path, line number, report body and private check details in local verification. A report receipt, file creation or successful send by itself does not establish acceptance: verify the declared `Done =` condition, including any expected file content.

## What happens next

1. The Dori gets a `LANE_DONE_CLAIMED` event, and you get a `[LEAD]` line saying when the lane closes.
2. Stay idle and start no new work.
3. If the Dori does not object within 5 minutes, the watcher closes the lane. Before closing, it reads back every `Done =` signal live. It refuses to close if any of your worktrees still has uncommitted tracked changes, or commits that are on no remote.
4. Closing marks your thread done (when a thread hook is configured), closes your tab, and removes your worktrees.

Before using the separate manual `dori close` path, check each lane worktree for uncommitted changes and commits not on a remote. Manual close still checks Done signals, but does not run the watcher's unpushed-work preflight.

Worktree discovery, pre-close Git checks and non-forced worktree cleanup discard inherited `GIT_*` overrides, such as `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`, so they inspect the selected repository rather than another Git invocation's context. The general command runner and user-supplied Done commands keep their normal environment, including Git identity and configuration. These Git diagnostics use the C locale. Missing roots and Git-confirmed non-repositories are skipped during discovery. Other discovery failures on an existing root hold automated Done with `git state unreadable`, even if the lane cwd is not a checkout. Unreadable Git state in an owned worktree or fallback checkout also holds automated Done. Required trust settings must be available in normal Git configuration, not solely in discarded `GIT_CONFIG_*` overrides.

## If the Dori objects, or a check fails

You get `[LEAD] not done: <reasons>; keep working, claim again when fixed` in your pane, and the lane goes back to not-done. This happens when:

- the Dori objects;
- a `Done =` signal does not read back live;
- there is unpushed work (the reason names the path).

Treat the rejection as noncompletion even if the preceding report said `done`. Append a `milestone` when work can continue or a `blocker` when it cannot, recording the reason, remaining checks and next action. Preserve the original report as history. After resolving every reason, read back every Done signal again. Save a new `done` report with the newly observed evidence and cite its new report ID and fresh shareable receipts in the next claim. A new claim starts a fresh 5-minute window; the watcher still verifies Done independently.
