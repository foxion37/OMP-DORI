import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readNativeArtifact } from "../src/release/native-update-artifact.ts";
import { NATIVE_UPDATE_FILES } from "../src/release/native-update-dependencies.ts";
import { bundleGit } from "../src/release/source-bundle.ts";
import { RELEASE_REPOSITORY } from "./release-gate.ts";
import { githubApi } from "./release-process.ts";
import {
  canonicalPull,
  existingNativeCommit,
  existingNativePull,
  type GitHubApi,
} from "./update-native-omp-existing.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const root = `repos/${RELEASE_REPOSITORY}`;

async function mainAt(commit: string, api: GitHubApi) {
  const main = await api(`${root}/git/ref/heads/main`);
  if (!object(main) || !object(main["object"]) || main["object"]["sha"] !== commit)
    throw new Error("Main advanced after native preparation; prepare again instead of rebasing automatically");
}

async function dispatch(branch: string, commit: string, api: GitHubApi) {
  const runs = await api(
    `${root}/actions/workflows/ci.yml/runs?head_sha=${commit}&event=workflow_dispatch&per_page=100`,
  );
  if (!object(runs) || !Array.isArray(runs["workflow_runs"])) throw new Error("Invalid exact-head CI lookup");
  if (runs["workflow_runs"].some((run) => object(run) && run["head_sha"] === commit)) return;
  const ref = await api(`${root}/git/ref/heads/${branch}`);
  if (!object(ref) || !object(ref["object"]) || ref["object"]["sha"] !== commit)
    throw new Error("Native candidate branch changed before CI dispatch");
  await api(`${root}/actions/workflows/ci.yml/dispatches`, "POST", { ref: branch });
}

/** Fresh trusted publisher: payloads are data only, fixed paths only, and no upstream code sees its write token. */
export async function publishNativeUpdate(
  source: string,
  directory: string,
  runId: string,
  api: GitHubApi = githubApi,
): Promise<string> {
  if (api === githubApi && process.env["GITHUB_REPOSITORY"] !== RELEASE_REPOSITORY)
    throw new Error("Native publication is restricted to the canonical repository");
  if (!/^[1-9]\d*$/.test(runId)) throw new Error("Invalid native preparation run identity");
  const candidate = readNativeArtifact(source, directory);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "native-publish-")));
  try {
    if (
      (await bundleGit(["rev-parse", "--verify", "HEAD^{commit}"], source, home)) !== candidate.sourceCommit ||
      (await bundleGit(["status", "--porcelain", "--untracked-files=all"], source, home)) !== ""
    )
      throw new Error("Native publisher source differs from the exact clean preparation commit");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  await mainAt(candidate.sourceCommit, api);
  const artifact = `https://github.com/${RELEASE_REPOSITORY}/actions/runs/${runId}/artifacts`;
  if (candidate.status !== "candidate") {
    const marker = `<!-- native-update:${candidate.commit}:${candidate.previousIdentity} -->`;
    const matches: unknown[] = [];
    for (let page = 1; ; page++) {
      const issues = await api(`${root}/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100&page=${page}`);
      if (!Array.isArray(issues)) throw new Error("Invalid native issue lookup");
      matches.push(
        ...issues.filter(
          (issue) => object(issue) && typeof issue["body"] === "string" && issue["body"].includes(marker),
        ),
      );
      if (issues.length < 100) break;
    }
    if (matches.length > 1) throw new Error("Ambiguous native update issue");
    const issue =
      matches[0] ??
      (await api(`${root}/issues`, "POST", {
        title: `Native OMP ${candidate.tag} needs a reviewed port`,
        body: `${marker}\n\nPreparation from Cataly ${candidate.sourceCommit} was held: ${candidate.reason}.\n\nUpstream ${candidate.previous} -> ${candidate.commit} (${candidate.tag}). No branch, merge, release, or installation was changed. No automatic conflict resolution was attempted.\n\nThe [native-candidate artifact](${artifact}) contains candidate.json and exact conflicts.patch bytes (SHA-256 ${candidate.identity}). For three-way failures this is Git's unresolved combined diff; for unsupported runtime/dependency holds it is the original overlay requiring review. Download it before the 30-day retention expires and attach it to the reviewed port. Exact hunks remain in the artifact, never interpreted as publisher code.`,
      }));
    if (
      !object(issue) ||
      !Number.isSafeInteger(issue["number"]) ||
      Number(issue["number"]) < 1 ||
      issue["html_url"] !== `https://github.com/${RELEASE_REPOSITORY}/issues/${issue["number"]}` ||
      issue["pull_request"] !== undefined
    )
      throw new Error("Invalid canonical native update issue");
    return String(issue["html_url"]);
  }
  const branch = `automation/native-${candidate.commit}-${candidate.sourceCommit.slice(0, 12)}`;
  const refs = await api(`${root}/git/matching-refs/heads/${branch}`);
  if (!Array.isArray(refs)) throw new Error("Invalid native branch lookup");
  const exact = refs.filter((ref) => object(ref) && ref["ref"] === `refs/heads/${branch}`);
  if (exact.length > 1) throw new Error("Ambiguous native branch identity");
  const ref = exact[0];
  let commit = object(ref) && object(ref["object"]) && sha(ref["object"]["sha"]) ? ref["object"]["sha"] : undefined;
  if (exact.length && !commit) throw new Error("Invalid existing native branch");
  if (commit) await existingNativeCommit(source, directory, candidate, commit, api);
  const prior = await existingNativePull(branch, commit, api);
  if (prior) {
    if (prior.state === "open") await dispatch(branch, commit!, api);
    return prior.url;
  }
  if (!commit) {
    const base = await api(`${root}/git/commits/${candidate.sourceCommit}`);
    if (!object(base) || !object(base["tree"]) || !sha(base["tree"]["sha"]))
      throw new Error("Invalid native preparation base tree");
    const files = [];
    for (const path of NATIVE_UPDATE_FILES) {
      const blob = await api(`${root}/git/blobs`, "POST", {
        encoding: "base64",
        content: readFileSync(join(directory, path)).toString("base64"),
      });
      if (!object(blob) || !sha(blob["sha"])) throw new Error("Invalid native candidate blob");
      files.push({ path, mode: "100644", type: "blob", sha: blob["sha"] });
    }
    const tree = await api(`${root}/git/trees`, "POST", { base_tree: base["tree"]["sha"], tree: files });
    if (!object(tree) || !sha(tree["sha"])) throw new Error("Invalid native candidate tree");
    const created = await api(`${root}/git/commits`, "POST", {
      message: `chore(native): stage OMP ${candidate.nativeVersion} with preserved overlay`,
      tree: tree["sha"],
      parents: [candidate.sourceCommit],
    });
    if (!object(created) || !sha(created["sha"])) throw new Error("Invalid native candidate commit");
    commit = created["sha"];
    await mainAt(candidate.sourceCommit, api);
    await api(`${root}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: commit });
  }
  const pull = canonicalPull(
    await api(`${root}/pulls`, "POST", {
      title: `chore(native): stage OMP ${candidate.nativeVersion}`,
      head: branch,
      base: "main",
      draft: true,
      body: `Prepared from exact Cataly ${candidate.sourceCommit}; native ${candidate.previous} -> ${candidate.commit} (${candidate.tag}).\n\nThe overlay applied without textual three-way conflicts. Native identity and required addon, extension, and real-host fixture package pins/frozen locks were regenerated with lifecycle scripts disabled. This is not semantic compatibility approval or a passing CI claim.\n\nExact-head CI is dispatched on ${commit}. Review the required check results, breaking changes, notices, and isolated installation evidence before merging. No self-merge, approval, tag, release, consumer pointer, or live installation was changed.\n\n[Preparation artifact](${artifact}).`,
    }),
    branch,
    commit,
  );
  await dispatch(branch, commit, api);
  return pull.url;
}

if (import.meta.main) {
  try {
    if (process.env["GITHUB_REPOSITORY"] !== RELEASE_REPOSITORY)
      throw new Error("Native publication is restricted to the canonical repository");
    const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { from: { type: "string" } } });
    if (!values.from) throw new Error("Usage: bun scripts/update-native-omp-publish.ts --from DIRECTORY");
    console.log(
      await publishNativeUpdate(
        resolve(import.meta.dir, ".."),
        resolve(values.from),
        process.env["GITHUB_RUN_ID"] ?? "",
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
