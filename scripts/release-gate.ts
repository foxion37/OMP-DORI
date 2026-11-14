import { validateReleaseManifest } from "../src/release/manifest.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { releaseVersion } from "../src/release/version.ts";
import { object } from "../src/update/config.ts";
import { githubApi, githubPages } from "./release-process.ts";

export const RELEASE_REPOSITORY = "vntrevx/omp-dori";
const REQUIRED = ["check", "test-macos", "e2e-herdr", "e2e-hc"];
type Reads = { api: typeof githubApi; pages: typeof githubPages };

function record(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("GitHub release gate response is incomplete");
  return value;
}

function identifier(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("GitHub release gate identity is incomplete");
  }
  return value;
}

async function tagCommit(api: Reads["api"], tag: string): Promise<string> {
  const prefix = `repos/${RELEASE_REPOSITORY}`;
  let target = record(record(await api(`${prefix}/git/ref/tags/${tag}`))["object"]);
  const seen = new Set<string>();
  while (target["type"] === "tag") {
    const sha = target["sha"];
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha) || seen.has(sha) || seen.size >= 8) {
      throw new Error("GitHub release tag object is invalid");
    }
    seen.add(sha);
    const annotated = record(await api(`${prefix}/git/tags/${sha}`));
    if (annotated["sha"] !== sha) throw new Error("GitHub annotated tag identity changed");
    target = record(annotated["object"]);
  }
  if (target["type"] !== "commit" || typeof target["sha"] !== "string" || !/^[a-f0-9]{40}$/.test(target["sha"])) {
    throw new Error("GitHub release tag does not resolve to a commit");
  }
  return target["sha"];
}

function trustedRun(value: unknown, manifest: ReleaseManifest, workflow: number): Record<string, unknown> {
  const run = record(value);
  if (
    run["head_sha"] !== manifest.commit ||
    run["workflow_id"] !== workflow ||
    run["path"] !== ".github/workflows/ci.yml" ||
    run["event"] !== "push" ||
    run["head_branch"] !== "main" ||
    record(run["head_repository"])["full_name"] !== RELEASE_REPOSITORY
  ) {
    throw new Error("Release CI is not the own main ci.yml run for the exact tagged commit");
  }
  identifier(run["id"]);
  identifier(run["run_attempt"]);
  identifier(run["check_suite_id"]);
  return run;
}

/** Read-only: successful statuses from another workflow, app, commit or attempt never authorize a release. */
export async function releaseGate(
  value: ReleaseManifest,
  reads: Reads = { api: githubApi, pages: githubPages },
): Promise<void> {
  const manifest = validateReleaseManifest(value);
  if (manifest.releaseVersion !== releaseVersion) {
    throw new Error("Release version differs from the canonical package version");
  }
  const prefix = `repos/${RELEASE_REPOSITORY}`;
  if (
    record(await reads.api(prefix))["full_name"] !== RELEASE_REPOSITORY ||
    (await tagCommit(reads.api, manifest.tag)) !== manifest.commit
  ) {
    throw new Error("Canonical GitHub repository/tag does not identify the release commit");
  }
  const commit = record(await reads.api(`${prefix}/git/commits/${manifest.commit}`));
  if (commit["sha"] !== manifest.commit || record(commit["tree"])["sha"] !== manifest.tree) {
    throw new Error("Canonical GitHub commit/tree differs from the release manifest");
  }
  const main = record(record(await reads.api(`${prefix}/branches/main`))["commit"])["sha"];
  if (typeof main !== "string" || !/^[a-f0-9]{40}$/.test(main))
    throw new Error("Canonical main identity is incomplete");
  const comparison = record(await reads.api(`${prefix}/compare/${manifest.commit}...${main}`));
  if (
    !["ahead", "identical"].includes(String(comparison["status"])) ||
    record(comparison["base_commit"])["sha"] !== manifest.commit ||
    record(comparison["merge_base_commit"])["sha"] !== manifest.commit
  ) {
    throw new Error("Tagged release commit is not an ancestor of canonical main");
  }
  const releases = await reads.pages(`${prefix}/releases?per_page=100`);
  if (!manifest.prerelease && !releases.some((release) => record(release)["draft"] === false)) {
    throw new Error("The first public release must be a prerelease");
  }
  const workflow = record(await reads.api(`${prefix}/actions/workflows/ci.yml`));
  const workflowId = identifier(workflow["id"]);
  if (workflow["path"] !== ".github/workflows/ci.yml" || workflow["state"] !== "active") {
    throw new Error("Own CI workflow is unavailable");
  }
  const candidates = (
    await reads.pages(
      `${prefix}/actions/workflows/${workflowId}/runs?head_sha=${manifest.commit}&event=push&per_page=100`,
      "workflow_runs",
    )
  ).map((run) => trustedRun(run, manifest, workflowId));
  candidates.sort((a, b) => Number(b["id"]) - Number(a["id"]));
  if (!candidates.length) throw new Error("No exact-commit main CI run exists; tag pushes do not run ci.yml");
  const run = trustedRun(await reads.api(`${prefix}/actions/runs/${candidates[0]!["id"]}`), manifest, workflowId);
  const id = identifier(run["id"]);
  const attempt = identifier(run["run_attempt"]);
  if (id !== candidates[0]!["id"] || run["status"] !== "completed" || run["conclusion"] !== "success") {
    throw new Error("Latest exact-commit own CI run has not succeeded");
  }
  const jobs = (await reads.pages(`${prefix}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`, "jobs")).map(
    record,
  );
  const requiredChecks = REQUIRED.map((name) => {
    const matches = jobs.filter((job) => job["name"] === name);
    if (matches.length !== 1) throw new Error(`Required exact-commit CI job is missing or ambiguous: ${name}`);
    const job = matches[0]!;
    const match =
      typeof job["check_run_url"] === "string"
        ? /^https:\/\/api\.github\.com\/repos\/vntrevx\/omp-dori\/check-runs\/(\d+)$/.exec(job["check_run_url"])
        : null;
    if (
      job["head_sha"] !== manifest.commit ||
      job["run_id"] !== id ||
      job["run_attempt"] !== attempt ||
      job["status"] !== "completed" ||
      job["conclusion"] !== "success" ||
      !match
    ) {
      throw new Error(`Required CI job did not succeed for the exact attempt: ${name}`);
    }
    return { name, checkId: Number(match[1]) };
  });
  // Only these four independent GETs overlap. Drain all reads before validating in required-job order.
  const results = await Promise.allSettled(
    requiredChecks.map(({ checkId }) => reads.api(`${prefix}/check-runs/${checkId}`)),
  );
  for (const [index, { name, checkId }] of requiredChecks.entries()) {
    const result = results[index]!;
    if (result.status === "rejected") throw result.reason;
    const check = record(result.value);
    if (
      check["id"] !== checkId ||
      check["head_sha"] !== manifest.commit ||
      check["name"] !== name ||
      check["status"] !== "completed" ||
      check["conclusion"] !== "success" ||
      record(check["app"])["id"] !== 15368 ||
      record(check["check_suite"])["id"] !== run["check_suite_id"]
    ) {
      throw new Error(`Required CI check lacks trusted GitHub Actions app15368/workflow binding: ${name}`);
    }
  }
  const final = trustedRun(await reads.api(`${prefix}/actions/runs/${id}`), manifest, workflowId);
  if (
    final["id"] !== id ||
    final["run_attempt"] !== attempt ||
    final["status"] !== "completed" ||
    final["conclusion"] !== "success" ||
    (await tagCommit(reads.api, manifest.tag)) !== manifest.commit ||
    record(record(await reads.api(`${prefix}/branches/main`))["commit"])["sha"] !== main
  ) {
    throw new Error("CI attempt, release tag or canonical main changed during the publication gate");
  }
}
