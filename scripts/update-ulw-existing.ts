import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ULW_UPDATE_FILES, type UlwCandidate } from "../src/release/source-bundle-update.ts";
import { RELEASE_REPOSITORY } from "./release-gate.ts";

export type UlwApi = (path: string, method?: string, body?: unknown) => Promise<unknown>;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const root = `repos/${RELEASE_REPOSITORY}`;

/** A matching list result is not enough: bind both sides of the PR to this repository and exact branch/head. */
export function canonicalUlwPull(value: unknown, branch: string, commit: string) {
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
    throw new Error("Existing ULW pull request differs from its canonical branch and head");
  return { url: String(value["html_url"]), state: String(value["state"]) };
}

type Entry = { mode: string; type: string; sha: string };
async function treeEntries(tree: string, api: UlwApi): Promise<Map<string, Entry>> {
  const value = await api(`${root}/git/trees/${tree}`);
  if (!object(value) || value["sha"] !== tree || value["truncated"] !== false || !Array.isArray(value["tree"]))
    throw new Error("Incomplete existing ULW tree");
  const result = new Map<string, Entry>();
  for (const entry of value["tree"]) {
    if (
      !object(entry) ||
      typeof entry["path"] !== "string" ||
      !entry["path"] ||
      entry["path"].includes("/") ||
      result.has(entry["path"]) ||
      typeof entry["mode"] !== "string" ||
      typeof entry["type"] !== "string" ||
      !sha(entry["sha"])
    )
      throw new Error("Invalid existing ULW tree entry");
    result.set(entry["path"], { mode: entry["mode"], type: entry["type"], sha: entry["sha"] });
  }
  return result;
}
const blob = (path: string) => {
  const bytes = readFileSync(path);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};

/** Reuse only a proven metadata-only proposal based on an accepted ancestor, never rebase or overwrite it. */
export async function existingUlwPull(
  source: string,
  directory: string,
  candidate: UlwCandidate,
  branch: string,
  commit: string | undefined,
  api: UlwApi,
) {
  const pulls = await api(`${root}/pulls?state=all&head=${RELEASE_REPOSITORY.split("/")[0]}:${branch}&base=main`);
  if (!Array.isArray(pulls) || pulls.length > 1) throw new Error("Ambiguous ULW pull request lookup");
  if (!pulls.length) return undefined;
  if (!commit) throw new Error("Existing ULW pull request has no exact branch; no branch was recreated");
  const pull = canonicalUlwPull(pulls[0], branch, commit);
  const head = await api(`${root}/git/commits/${commit}`);
  if (
    !object(head) ||
    head["sha"] !== commit ||
    !object(head["tree"]) ||
    !sha(head["tree"]["sha"]) ||
    !Array.isArray(head["parents"]) ||
    head["parents"].length !== 1 ||
    !object(head["parents"][0]) ||
    !sha(head["parents"][0]["sha"])
  )
    throw new Error("Invalid existing ULW candidate commit");
  const parent = head["parents"][0]["sha"];
  if (parent !== candidate.sourceCommit) {
    const ancestry = await api(`${root}/compare/${parent}...${candidate.sourceCommit}`);
    if (
      !object(ancestry) ||
      ancestry["status"] !== "ahead" ||
      ancestry["behind_by"] !== 0 ||
      !Number.isSafeInteger(ancestry["ahead_by"]) ||
      Number(ancestry["ahead_by"]) < 1 ||
      !object(ancestry["base_commit"]) ||
      ancestry["base_commit"]["sha"] !== parent ||
      !object(ancestry["merge_base_commit"]) ||
      ancestry["merge_base_commit"]["sha"] !== parent
    )
      throw new Error("Existing ULW candidate parent is not an accepted main ancestor");
  }
  const base = await api(`${root}/git/commits/${parent}`);
  if (!object(base) || base["sha"] !== parent || !object(base["tree"]) || !sha(base["tree"]["sha"]))
    throw new Error("Invalid existing ULW candidate parent");
  const before = await treeEntries(base["tree"]["sha"], api);
  const after = await treeEntries(head["tree"]["sha"], api);
  if (before.size !== after.size) throw new Error("Existing ULW candidate changed non-metadata paths");
  for (const path of ULW_UPDATE_FILES) {
    for (const [entries, bytes] of [
      [before, source],
      [after, directory],
    ] as const) {
      const entry = entries.get(path);
      if (entry?.mode !== "100644" || entry.type !== "blob" || entry.sha !== blob(join(bytes, path)))
        throw new Error("Existing ULW candidate differs from the exact previous or proposed metadata");
    }
  }
  for (const [path, entry] of before) {
    if (ULW_UPDATE_FILES.some((file) => file === path)) continue;
    if (JSON.stringify(after.get(path)) !== JSON.stringify(entry))
      throw new Error("Existing ULW candidate changed non-metadata paths");
  }
  return pull;
}
