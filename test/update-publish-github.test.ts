import { expect, test } from "bun:test";
import { join } from "node:path";
import { githubGate } from "../src/update/publish-github.ts";
import { PublicationProcess } from "../src/update/publish-process.ts";
import type { PublicationRecord } from "../src/update/publish-types.ts";
import { fixture } from "./update-setup.ts";

function githubFixture(snapshots: readonly Record<string, unknown>[], wrongCheckHead = false) {
  const f = fixture();
  const record: PublicationRecord = {
    version: 1,
    status: "awaiting-ci",
    remote: "https://github.com/owner/repo.git",
    ref: "refs/heads/main",
    branch: "refs/heads/dori-update/fixture",
    expectedMain: "a".repeat(40),
    basis: { kind: "matched-main" },
    sourceHash: "c".repeat(64),
    exportHash: "d".repeat(64),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    commit: "b".repeat(40),
    tree: "e".repeat(40),
  };
  const publisher = new PublicationProcess(
    {
      remote: record.remote,
      ref: record.ref,
      author: { name: "GitHub gate fixture", email: "gate@example.invalid" },
      github: { gh: process.execPath, credentialHome: f.directory, requiredChecks: ["types"] },
    },
    join(f.directory, "publication"),
  );
  const events: string[] = [];
  let reads = 0;
  // Only the API boundary is simulated; no remote CI status or real publication is created.
  publisher.api = async (path) => {
    if (path === "repos/owner/repo/pulls/7") {
      events.push("pr");
      const snapshot = snapshots[Math.min(reads++, snapshots.length - 1)]!;
      return {
        state: "open",
        draft: false,
        head: { sha: record.commit, repo: { full_name: "owner/repo" } },
        base: { sha: record.expectedMain, ref: "main", repo: { full_name: "owner/repo" } },
        requested_reviewers: [],
        requested_teams: [],
        ...snapshot,
      };
    }
    if (path === "repos/owner/repo/branches/main") {
      return { protected: false, commit: { sha: record.expectedMain } };
    }
    if (path === "repos/owner/repo/rules/branches/main") return [];
    throw new Error(`Unexpected fixture GitHub API request: ${path}`);
  };
  publisher.pages = async (path) => {
    if (path.startsWith("repos/owner/repo/pulls?")) {
      return [[{ number: 7, head: { ref: "dori-update/fixture" } }]];
    }
    if (path === `repos/owner/repo/commits/${record.commit}/check-runs?per_page=100`) {
      events.push("checks");
      return [
        {
          check_runs: [
            {
              id: 1,
              head_sha: wrongCheckHead ? "f".repeat(40) : record.commit,
              name: "types",
              status: "completed",
              conclusion: "success",
              app: { id: 1 },
            },
          ],
        },
      ];
    }
    if (path === `repos/owner/repo/commits/${record.commit}/status?per_page=100`) {
      events.push("statuses");
      return [{ sha: record.commit, statuses: [] }];
    }
    throw new Error(`Unexpected fixture GitHub page request: ${path}`);
  };
  return { publisher, record, events };
}

test("successful exact-head checks reread a stale blocked PR before allowing publication", async () => {
  const f = githubFixture([
    { mergeable: true, mergeable_state: "blocked" },
    { mergeable: true, mergeable_state: "clean" },
  ]);
  expect(await githubGate(f.publisher, f.record, () => {})).toEqual({ state: "passed" });
  expect(f.events).toEqual(["pr", "checks", "statuses", "pr"]);
  expect(f.record.ci).toMatchObject({ head: f.record.commit, checks: ["types"] });
});

test("an asynchronously blocked merge state stays resumable until a fresh PR read becomes clean", async () => {
  const f = githubFixture([
    { mergeable: true, mergeable_state: "blocked" },
    { mergeable: true, mergeable_state: "blocked" },
    { mergeable: true, mergeable_state: "blocked" },
    { mergeable: true, mergeable_state: "clean" },
  ]);
  expect(await githubGate(f.publisher, f.record, () => {})).toEqual({ state: "waiting" });
  expect(f.record.status).toBe("awaiting-ci");
  expect(f.record.ci).toBeUndefined();
  expect(await githubGate(f.publisher, f.record, () => {})).toEqual({ state: "passed" });
  expect(f.record.ci?.head).toBe(f.record.commit);
});

test.each(["conflict", "dirty"] as const)(
  "a true %s merge condition remains held after successful CI",
  async (kind) => {
    const f = githubFixture([
      { mergeable: true, mergeable_state: "clean" },
      { mergeable: kind !== "conflict", mergeable_state: kind === "dirty" ? "dirty" : "blocked" },
    ]);
    expect((await githubGate(f.publisher, f.record, () => {})).state).toBe("held");
    expect(f.record.ci).toBeUndefined();
  },
);

test.each(["head", "base", "reviewer"] as const)(
  "a refreshed PR %s change preserves exact publication gates",
  async (kind) => {
    const changed: Record<string, unknown> =
      kind === "reviewer"
        ? { requested_reviewers: [{ login: "owner" }] }
        : { [kind]: { sha: "f".repeat(40), ref: "main", repo: { full_name: "owner/repo" } } };
    const f = githubFixture([
      { mergeable: true, mergeable_state: "clean" },
      { mergeable: true, mergeable_state: "clean", ...changed },
    ]);
    expect((await githubGate(f.publisher, f.record, () => {})).state).toBe("held");
    expect(f.record.ci).toBeUndefined();
  },
);

test("checks for another head stop publication before a refreshed merge state is trusted", async () => {
  const f = githubFixture([{ mergeable: true, mergeable_state: "clean" }], true);
  await expect(githubGate(f.publisher, f.record, () => {})).rejects.toThrow("another head");
  expect(f.events).toEqual(["pr", "checks", "statuses"]);
  expect(f.record.ci).toBeUndefined();
});
