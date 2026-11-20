import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readJson, regularFile } from "../src/release/files.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { ULW_UPDATE_FILES, type UlwCandidate } from "../src/release/source-bundle-update.ts";
import { RELEASE_REPOSITORY } from "./release-gate.ts";
import { githubApi } from "./release-process.ts";
import { canonicalUlwPull, existingUlwPull, type UlwApi } from "./update-ulw-existing.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
type Api = UlwApi;

/** A fresh trusted job publishes only three validated metadata files; candidate/upstream code never sees its token. */
export async function publishUlwCandidate(source: string, directory: string, api: Api = githubApi): Promise<string> {
  const value = readJson(join(directory, "candidate.json"));
  if (
    !object(value) ||
    Object.keys(value).sort().join() !== "commit,identity,previous,previousIdentity,sourceCommit,version" ||
    value["version"] !== 1 ||
    !sha(value["sourceCommit"]) ||
    !sha(value["previous"]) ||
    !sha(value["commit"]) ||
    !hash(value["previousIdentity"]) ||
    !hash(value["identity"])
  )
    throw new Error("Invalid ULW candidate receipt");
  const candidate = value as unknown as UlwCandidate;
  if (readdirSync(directory).sort().join() !== ["candidate.json", ...ULW_UPDATE_FILES].sort().join())
    throw new Error("Unexpected ULW candidate artifact files");
  for (const file of ULW_UPDATE_FILES) {
    if (!regularFile(join(directory, file)) || lstatSync(join(directory, file)).size > 16 * 1024 * 1024)
      throw new Error("Invalid or oversized ULW candidate artifact");
  }
  const previous = readSourceBundle(source);
  const next = readSourceBundle(directory);
  if (
    previous["identity"] !== candidate["previousIdentity"] ||
    previous.lock["commit"] !== candidate["previous"] ||
    next["identity"] !== candidate["identity"] ||
    next.lock["commit"] !== candidate["commit"] ||
    readFileSync(join(directory, "omp-ulw.lock"), "utf8") !== `${candidate["commit"]}\n` ||
    candidate["previous"] === candidate["commit"]
  )
    throw new Error("ULW candidate differs from its authenticated bundle identities");
  const root = `repos/${RELEASE_REPOSITORY}`;
  const main = await api(`${root}/git/ref/heads/main`);
  if (!object(main) || !object(main["object"]) || main["object"]["sha"] !== candidate["sourceCommit"])
    throw new Error("Main advanced after ULW preparation; prepare a fresh candidate instead of rebasing automatically");
  const branch = `automation/ulw-${candidate["commit"]}-${candidate["previousIdentity"].slice(0, 12)}`;
  const refs = await api(`${root}/git/matching-refs/heads/${branch}`);
  if (!Array.isArray(refs)) throw new Error("Invalid ULW branch lookup");
  const exact = refs.filter((ref) => object(ref) && ref["ref"] === `refs/heads/${branch}`);
  if (exact.length > 1) throw new Error("Ambiguous ULW branch identity");
  const ref = exact[0];
  const known = object(ref) && object(ref["object"]) && sha(ref["object"]["sha"]) ? ref["object"]["sha"] : undefined;
  if (exact.length && !known) throw new Error("Invalid existing ULW branch");
  const prior = await existingUlwPull(source, directory, candidate, branch, known, api);
  if (prior) {
    if (prior.state === "open") await dispatchIfUnrun(root, branch, known!, api);
    return prior.url;
  }
  const base = await api(`${root}/git/commits/${candidate["sourceCommit"]}`);
  if (!object(base) || !object(base["tree"]) || !sha(base["tree"]["sha"])) throw new Error("Invalid Dori base commit");
  const files = [];
  for (const path of ULW_UPDATE_FILES) {
    const blob = await api(`${root}/git/blobs`, "POST", {
      encoding: "base64",
      content: readFileSync(join(directory, path)).toString("base64"),
    });
    if (!object(blob) || !sha(blob["sha"])) throw new Error("GitHub did not create the exact ULW blob");
    files.push({ path, mode: "100644", type: "blob", sha: blob["sha"] });
  }
  const tree = await api(`${root}/git/trees`, "POST", { base_tree: base["tree"]["sha"], tree: files });
  if (!object(tree) || !sha(tree["sha"])) throw new Error("GitHub did not create the exact ULW tree");
  let commit: string;
  if (exact.length) {
    const ref = exact[0];
    if (!object(ref) || !object(ref["object"]) || !sha(ref["object"]["sha"]))
      throw new Error("Invalid existing ULW branch");
    commit = ref["object"]["sha"];
    const existing = await api(`${root}/git/commits/${commit}`);
    if (
      !object(existing) ||
      !object(existing["tree"]) ||
      existing["tree"]["sha"] !== tree["sha"] ||
      !Array.isArray(existing["parents"]) ||
      existing["parents"].length !== 1 ||
      !object(existing["parents"][0]) ||
      existing["parents"][0]["sha"] !== candidate["sourceCommit"]
    )
      throw new Error("Existing ULW branch changed; no branch was overwritten");
  } else {
    const created = await api(`${root}/git/commits`, "POST", {
      message: `chore(ulw): stage upstream ${candidate["commit"].slice(0, 12)} with preserved overlay`,
      tree: tree["sha"],
      parents: [candidate["sourceCommit"]],
    });
    if (!object(created) || !sha(created["sha"])) throw new Error("Invalid ULW candidate commit");
    commit = created["sha"];
    await api(`${root}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: commit });
  }
  const pull = await api(`${root}/pulls`, "POST", {
    title: `chore(ulw): stage upstream ${candidate["commit"].slice(0, 12)}`,
    head: branch,
    base: "main",
    draft: true,
    body: `Automatically prepared from Dori ${candidate["sourceCommit"]}.\n\nULW ${candidate["previous"]} → ${candidate["commit"]}. The current overlay applied without a Git three-way conflict and its new patch/tree/file hashes were verified. This is **not** a compatibility review or passing CI claim.\n\nThe existing CI workflow is dispatched on exact candidate ${commit}; all required checks and an independent review remain necessary before merge. Resolve any behavioral conflicts, update provenance as needed, then publish through the ordinary verified release process. No live install, consumer pointer, main ref, tag, release, or auto-merge setting was changed. Consumers only receive this through a separately reviewed compatible stable release.`,
  });
  const createdPull = canonicalUlwPull(pull, branch, commit);
  // GITHUB_TOKEN-created PRs do not trigger pull_request workflows. Explicit workflow_dispatch does.
  await dispatchIfUnrun(root, branch, commit, api);
  return createdPull.url;
}

async function dispatchIfUnrun(root: string, branch: string, commit: string, api: Api): Promise<void> {
  const runs = await api(
    `${root}/actions/workflows/ci.yml/runs?head_sha=${commit}&event=workflow_dispatch&per_page=100`,
  );
  if (!object(runs) || !Array.isArray(runs["workflow_runs"])) throw new Error("Invalid exact-head CI lookup");
  if (runs["workflow_runs"].some((run) => object(run) && run["head_sha"] === commit)) return;
  const ref = await api(`${root}/git/ref/heads/${branch}`);
  if (!object(ref) || !object(ref["object"]) || ref["object"]["sha"] !== commit)
    throw new Error("ULW branch changed before CI dispatch");
  await api(`${root}/actions/workflows/ci.yml/dispatches`, "POST", { ref: branch });
}

if (import.meta.main) {
  try {
    if (process.env["GITHUB_REPOSITORY"] !== RELEASE_REPOSITORY)
      throw new Error("ULW publication is restricted to the canonical repository");
    const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { from: { type: "string" } } });
    if (!values.from) throw new Error("Usage: bun scripts/update-ulw-publish.ts --from DIRECTORY");
    console.log(await publishUlwCandidate(resolve(import.meta.dir, ".."), resolve(values.from)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
