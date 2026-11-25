import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_UPDATE_FILES } from "../src/release/native-update-dependencies.ts";
import type { NativeCandidate } from "../src/release/native-update.ts";
import { RELEASE_REPOSITORY } from "./release-gate.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const root = `repos/${RELEASE_REPOSITORY}`;
const blob = (path: string) => {
  const bytes = readFileSync(path);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};

export type GitHubApi = (path: string, method?: string, body?: unknown) => Promise<unknown>;

/** A matching list result is not enough: bind both sides of the PR to this repository and exact branch/head. */
export function canonicalPull(value: unknown, branch: string, commit: string) {
  if (
    !object(value) ||
    !Number.isSafeInteger(value["number"]) ||
    Number(value["number"]) <= 0 ||
    value["html_url"] !== `https://github.com/${RELEASE_REPOSITORY}/pull/${value["number"]}` ||
    !["open", "closed"].includes(String(value["state"])) ||
    !object(value["head"]) ||
    value["head"]["ref"] !== branch ||
    value["head"]["sha"] !== commit ||
    !object(value["head"]["repo"]) ||
    value["head"]["repo"]["full_name"] !== RELEASE_REPOSITORY ||
    !object(value["base"]) ||
    value["base"]["ref"] !== "main" ||
    !object(value["base"]["repo"]) ||
    value["base"]["repo"]["full_name"] !== RELEASE_REPOSITORY
  )
    throw new Error("Existing pull request differs from its canonical branch and head");
  return { url: String(value["html_url"]), state: String(value["state"]) };
}

async function entries(tree: string, api: GitHubApi) {
  const result = await api(`${root}/git/trees/${tree}?recursive=1`);
  if (!object(result) || result["sha"] !== tree || result["truncated"] !== false || !Array.isArray(result["tree"]))
    throw new Error("Incomplete native candidate tree");
  const files = new Map<string, { mode: string; type: string; sha: string }>();
  for (const entry of result["tree"]) {
    if (
      !object(entry) ||
      typeof entry["path"] !== "string" ||
      entry["path"].split("/").some((part) => !part || part === "." || part === ".." || part === ".git") ||
      entry["path"].includes("\\") ||
      files.has(entry["path"]) ||
      typeof entry["mode"] !== "string" ||
      typeof entry["type"] !== "string" ||
      !sha(entry["sha"])
    )
      throw new Error("Invalid native candidate tree entry");
    if (entry["type"] !== "tree")
      files.set(entry["path"], { mode: entry["mode"], type: entry["type"], sha: entry["sha"] });
  }
  return files;
}

/** An existing branch is reusable only with one exact parent and precisely the authenticated file delta. */
export async function existingNativeCommit(
  source: string,
  directory: string,
  candidate: NativeCandidate,
  commit: string,
  api: GitHubApi,
): Promise<void> {
  const head = await api(`${root}/git/commits/${commit}`);
  const base = await api(`${root}/git/commits/${candidate.sourceCommit}`);
  if (
    !object(head) ||
    head["sha"] !== commit ||
    !object(head["tree"]) ||
    !sha(head["tree"]["sha"]) ||
    !Array.isArray(head["parents"]) ||
    head["parents"].length !== 1 ||
    !object(head["parents"][0]) ||
    head["parents"][0]["sha"] !== candidate.sourceCommit ||
    !object(base) ||
    base["sha"] !== candidate.sourceCommit ||
    !object(base["tree"]) ||
    !sha(base["tree"]["sha"])
  )
    throw new Error("Existing native candidate differs from its exact source commit");
  const before = await entries(base["tree"]["sha"], api);
  const after = await entries(head["tree"]["sha"], api);
  if (before.size !== after.size) throw new Error("Existing native branch changed unexpected files");
  for (const file of NATIVE_UPDATE_FILES) {
    for (const [tree, location] of [
      [before, source],
      [after, directory],
    ] as const) {
      const entry = tree.get(file);
      if (entry?.mode !== "100644" || entry.type !== "blob" || entry.sha !== blob(join(location, file)))
        throw new Error("Existing native branch differs from the authenticated candidate files");
    }
  }
  for (const [path, entry] of before) {
    if (NATIVE_UPDATE_FILES.some((file) => file === path)) continue;
    if (JSON.stringify(after.get(path)) !== JSON.stringify(entry))
      throw new Error("Existing native branch changed unexpected files");
  }
}

export async function existingNativePull(branch: string, commit: string | undefined, api: GitHubApi) {
  const pulls = await api(`${root}/pulls?state=all&head=${RELEASE_REPOSITORY.split("/")[0]}:${branch}&base=main`);
  if (!Array.isArray(pulls) || pulls.length > 1) throw new Error("Ambiguous native pull request lookup");
  if (!pulls.length) return undefined;
  if (!commit) throw new Error("Existing native pull has no exact branch; no branch was recreated");
  return canonicalPull(pulls[0], branch, commit);
}
