import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../update/source.ts";
import type { SourceEntry } from "../update/types.ts";
import { bundleGit, type SourceBundle } from "./source-bundle.ts";

/** Capture the reviewed index as a full-identity patch and exact-byte postimage lock; the caller adds native fields. */
export async function generateSourceBundle(
  checkout: string,
  patchPath: string,
  repository: string,
  home: string,
): Promise<Omit<SourceBundle, "nativeVersion" | "launcher">> {
  const git = (argv: readonly string[]) => bundleGit(argv, checkout, home);
  const commit = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
  await git(["diff", "--cached", "--binary", "--full-index", `--output=${patchPath}`, "HEAD", "--"]);
  const patch = readFileSync(patchPath);
  if (!patch.length) throw new Error("Source overlay is now empty; a reviewed no-overlay migration is required");
  const raw = await git(["diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z", "HEAD", "--"]);
  const entries = raw.split("\0");
  if (entries.pop() !== "" || entries.length % 2) throw new Error("Invalid source postimage listing");
  const files: SourceEntry[] = [];
  for (let i = 0; i < entries.length; i += 2) {
    const entry = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} [AMDT]$/.exec(entries[i]!);
    const path = entries[i + 1]!;
    if (!entry) throw new Error("Invalid source overlay change");
    if (entry[2] === "000000") continue;
    if (!/^(100644|100755)$/.test(entry[2]!)) throw new Error("Source overlay changes a non-regular file");
    const actual = join(checkout, path);
    const stat = lstatSync(actual);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source overlay postimage is not a regular file");
    files.push({ path, sha256: digest(readFileSync(actual)), executable: entry[2] === "100755" });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    version: 1,
    repository,
    commit,
    patchSha256: digest(patch),
    resultTree: await git(["write-tree"]),
    files,
  };
}
