import { expect, test } from "bun:test";
import { releaseGate } from "../scripts/release-gate.ts";
import { githubFixture } from "./release-producer-setup.ts";

test("allows only a real complete CI4 response bound to the tagged commit, workflow and Actions app", async () => {
  const f = githubFixture();
  await expect(releaseGate(f.manifest, f.reads)).resolves.toBeUndefined();
});

test.each(["application", "suite", "head"])("holds a successful-looking check with a different %s", async (kind) => {
  const f = githubFixture();
  if (kind === "application") f.checks[0]!.app.id = 999;
  if (kind === "suite") f.checks[0]!.check_suite.id = 91;
  if (kind === "head") f.checks[0]!.head_sha = "9".repeat(40);
  await expect(releaseGate(f.manifest, f.reads)).rejects.toThrow("binding");
});

test.each(["skipped", "failure", "cancelled"])("holds a required CI job whose conclusion is %s", async (conclusion) => {
  const f = githubFixture();
  f.jobs[0]!["conclusion"] = conclusion;
  await expect(releaseGate(f.manifest, f.reads)).rejects.toThrow("did not succeed");
});

test("holds an incomplete or duplicate required job instead of accepting partial CI success", async () => {
  for (const duplicate of [false, true]) {
    const f = githubFixture();
    if (duplicate) f.jobs.push({ ...f.jobs[0]! });
    else f.jobs.pop();
    await expect(releaseGate(f.manifest, f.reads)).rejects.toThrow("missing or ambiguous");
  }
});

test.each([
  { path: ".github/workflows/other.yml" },
  { event: "pull_request" },
  { head_repository: { full_name: "other/fork" } },
  { head_sha: "9".repeat(40) },
])("holds a CI run from a different trust boundary: %j", async (change) => {
  const f = githubFixture();
  Object.assign(f.run, change);
  await expect(releaseGate(f.manifest, f.reads)).rejects.toThrow("own main ci.yml");
});

test("a newer failed CI run blocks an older successful run at the same commit", async () => {
  const f = githubFixture();
  const failed = { ...f.run, id: 71, conclusion: "failure" };
  f.runs.push(failed);
  f.responses[`${f.prefix}/actions/runs/71`] = failed;
  await expect(releaseGate(f.manifest, f.reads)).rejects.toThrow("Latest exact-commit");
});

test("a tag alone never substitutes for a main CI run", async () => {
  const f = githubFixture();
  f.runs.length = 0;
  await expect(releaseGate(f.manifest, f.reads)).rejects.toThrow("tag pushes do not run ci.yml");
});

test("a divergent canonical main blocks publication despite successful exact-head CI", async () => {
  const f = githubFixture();
  f.responses[`${f.prefix}/compare/${f.manifest.commit}...${f.manifest.commit}`] = {
    status: "diverged",
    base_commit: { sha: f.manifest.commit },
    merge_base_commit: { sha: "9".repeat(40) },
  };
  await expect(releaseGate(f.manifest, f.reads)).rejects.toThrow("ancestor");
});

test("a tag move while CI is being checked invalidates the publication gate", async () => {
  const f = githubFixture();
  const api = f.reads.api;
  let tags = 0;
  f.reads.api = async (path) => {
    if (path === `${f.prefix}/git/ref/tags/${f.manifest.tag}` && ++tags > 1) {
      return { object: { type: "commit", sha: "9".repeat(40) } };
    }
    return api(path);
  };
  await expect(releaseGate(f.manifest, f.reads)).rejects.toThrow("changed");
});

test("first publication stays prerelease even when all CI checks pass", async () => {
  const f = githubFixture();
  await expect(releaseGate({ ...f.manifest, prerelease: false }, f.reads)).rejects.toThrow("first public release");
});

test("an annotated tag must peel to the exact manifest commit", async () => {
  const f = githubFixture();
  const annotation = "8".repeat(40);
  f.responses[`${f.prefix}/git/ref/tags/${f.manifest.tag}`] = { object: { type: "tag", sha: annotation } };
  f.responses[`${f.prefix}/git/tags/${annotation}`] = {
    sha: annotation,
    object: { type: "commit", sha: "9".repeat(40) },
  };
  await expect(releaseGate(f.manifest, f.reads)).rejects.toThrow("release commit");
});

test("a new CI attempt started during readback invalidates prior successful jobs", async () => {
  const f = githubFixture();
  const api = f.reads.api;
  let runs = 0;
  f.reads.api = async (path) => {
    if (path === `${f.prefix}/actions/runs/70` && ++runs > 1) {
      return { ...f.run, run_attempt: 3, status: "in_progress", conclusion: null };
    }
    return api(path);
  };
  await expect(releaseGate(f.manifest, f.reads)).rejects.toThrow("changed");
});
