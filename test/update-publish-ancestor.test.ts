import { expect, test } from "bun:test";
import { publishRelease } from "../src/update/publish.ts";
import type { PublicationRecord } from "../src/update/publish-types.ts";
import { readState } from "../src/update/state.ts";
import { git, publicationFixture } from "./update-setup.ts";

test.each(["published", "main-pushing"] as const)(
  "a %s receipt resumes as published when owner main advances beyond its commit",
  async (status) => {
    const f = await publicationFixture();
    const commands = structuredClone(f.job.commands);
    const review = structuredClone(f.job.review);
    const history = structuredClone(f.job.history);
    const state = readState(f.updater.context);
    const first = await publishRelease(f.updater.context, state, f.job, undefined, () => {});
    const previous: PublicationRecord = { ...structuredClone(first.record), status };
    const commit = previous.commit!;
    git(f.seed, "fetch", f.target, "refs/heads/main");
    git(f.seed, "merge", "--ff-only", "FETCH_HEAD");
    f.write(f.seed, "owner-history.txt", "owner work after successful publication\n");
    git(f.seed, "add", ".");
    git(f.seed, "commit", "-m", "Owner continues after publication");
    const owner = git(f.seed, "rev-parse", "HEAD");
    git(f.seed, "push", f.target, "HEAD:refs/heads/main");
    git(f.target, "update-ref", "-d", previous.branch, commit);
    const receipts: PublicationRecord[] = [];
    const resumed = await publishRelease(f.updater.context, state, f.job, previous, (record) => {
      receipts.push(structuredClone(record));
    });
    expect(resumed.record.status).toBe("published");
    expect(resumed.record.commit).toBe(commit);
    expect(resumed.record.tree).toBe(first.record.tree);
    expect(resumed.record.ci).toEqual(first.record.ci);
    expect(resumed.record.expectedMain).toBe(f.expectedMain);
    expect(resumed.observedMain).toBe(owner);
    expect(receipts.every((record) => record.status === status || record.status === "published")).toBe(true);
    expect(git(f.target, "rev-parse", "main")).toBe(owner);
    expect(git(f.target, "show", "main:owner-history.txt")).toBe("owner work after successful publication");
    expect(git(f.target, "merge-base", commit, owner)).toBe(commit);
    expect(git(f.target, "for-each-ref", "--format=%(refname)", previous.branch)).toBe("");
    expect(f.job.phase).toBe("ready");
    expect(f.job.commands).toEqual(commands);
    expect(f.job.review).toEqual(review);
    expect(f.job.history).toEqual(history);
  },
);
