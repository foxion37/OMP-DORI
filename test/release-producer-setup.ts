import { RELEASE_REPOSITORY } from "../scripts/release-gate.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { releaseVersion } from "../src/release/version.ts";
import { digest } from "../src/update/source.ts";
import type { SourceEntry } from "../src/update/types.ts";

/** The smallest valid v2 release: every required native, headless and launcher file plus one source file. */
export function releaseFixture(
  files: SourceEntry[] = [
    { path: "install.sh", sha256: digest("#!/bin/sh\n"), executable: true },
    { path: "native-addon/bun.lock", sha256: digest("addon lock\n"), executable: false },
    { path: "native-addon/package.json", sha256: digest("{}\n"), executable: false },
    { path: "native-omp.lock", sha256: digest("{}\n"), executable: false },
    { path: "native-omp.patch", sha256: digest("\n"), executable: false },
    { path: "release-headless.json", sha256: digest("{}\n"), executable: false },
    { path: "scripts/consumer/omp", sha256: digest("#!/bin/sh\n"), executable: true },
    { path: "scripts/previous-install/cli.ts", sha256: digest("export {};\n"), executable: false },
    { path: "scripts/source-dependencies.ts", sha256: digest("export {};\n"), executable: false },
    { path: "src/cli.ts", sha256: digest("export {};\n"), executable: false },
  ],
): ReleaseManifest {
  return {
    version: 2,
    product: "cataly",
    releaseVersion,
    tag: `v${releaseVersion}`,
    commit: "1".repeat(40),
    tree: "2".repeat(40),
    prerelease: true,
    archive: {
      name: `cataly-v${releaseVersion}.tar.gz`,
      root: `cataly-${releaseVersion}`,
      sha256: digest("fixture archive"),
      bytes: 123,
    },
    source: { version: 1, hash: digest(JSON.stringify({ files })), files, excluded: [] },
    requirements: { omp: "19.0.1" },
  };
}

export function githubFixture(jobNames: readonly string[] = ["check"], repository = RELEASE_REPOSITORY) {
  const manifest = releaseFixture();
  const prefix = `repos/${repository}`;
  const run: Record<string, unknown> = {
    id: 70,
    run_attempt: 2,
    check_suite_id: 90,
    workflow_id: 50,
    head_sha: manifest.commit,
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_repository: { full_name: repository },
    status: "completed",
    conclusion: "success",
  };
  const jobs: Record<string, unknown>[] = jobNames.map((name, i) => ({
    name,
    head_sha: manifest.commit,
    run_id: 70,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    check_run_url: `https://api.github.com/repos/${repository}/check-runs/${100 + i}`,
  }));
  const checks = jobs.map((job, i) => ({
    id: 100 + i,
    name: job["name"],
    head_sha: manifest.commit,
    status: "completed",
    conclusion: "success",
    app: { id: 15368 },
    check_suite: { id: 90 },
  }));
  const responses: Record<string, unknown> = {
    [prefix]: { full_name: repository },
    [`${prefix}/git/ref/tags/${manifest.tag}`]: { object: { type: "commit", sha: manifest.commit } },
    [`${prefix}/git/commits/${manifest.commit}`]: { sha: manifest.commit, tree: { sha: manifest.tree } },
    [`${prefix}/branches/main`]: { commit: { sha: manifest.commit } },
    [`${prefix}/compare/${manifest.commit}...${manifest.commit}`]: {
      status: "identical",
      base_commit: { sha: manifest.commit },
      merge_base_commit: { sha: manifest.commit },
    },
    [`${prefix}/actions/workflows/ci.yml`]: { id: 50, path: ".github/workflows/ci.yml", state: "active" },
    [`${prefix}/actions/runs/70`]: run,
  };
  checks.forEach((check) => {
    responses[`${prefix}/check-runs/${check.id}`] = check;
  });
  const runs: unknown[] = [run];
  const releases: unknown[] = [];
  const reads = {
    api: async (path: string): Promise<unknown> => {
      if (!Object.hasOwn(responses, path)) throw new Error(`Unexpected API boundary: ${path}`);
      return structuredClone(responses[path]);
    },
    pages: async (path: string, collection?: string): Promise<unknown[]> => {
      if (path === `${prefix}/releases?per_page=100` && collection === undefined) return structuredClone(releases);
      if (
        path === `${prefix}/actions/workflows/50/runs?head_sha=${manifest.commit}&event=push&per_page=100` &&
        collection === "workflow_runs"
      )
        return structuredClone(runs);
      if (path === `${prefix}/actions/runs/70/attempts/2/jobs?per_page=100` && collection === "jobs") {
        return structuredClone(jobs);
      }
      throw new Error(`Unexpected paginated boundary: ${path}`);
    },
  };
  return { manifest, prefix, reads, responses, run, runs, jobs, checks };
}
