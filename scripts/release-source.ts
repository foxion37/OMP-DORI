import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { publicReleasePath } from "../src/release/manifest.ts";
import { assertSourceAdmission, sourceManifest } from "../src/update/source.ts";
import type { SourceManifest } from "../src/update/types.ts";
import { command, git } from "./release-process.ts";

type CommittedFile = { path: string; oid: string; executable: boolean };

async function committedFiles(root: string, commit: string): Promise<CommittedFile[]> {
  const tree = await git(root, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const files: CommittedFile[] = [];
  for (const row of tree.toString("utf8").split("\0").filter(Boolean)) {
    const split = row.indexOf("\t");
    const [mode, type, oid] = row.slice(0, split).split(" ");
    const path = row.slice(split + 1);
    if (split < 0) throw new Error("Committed Git tree response is malformed");
    if (!publicReleasePath(path)) continue;
    if (type !== "blob" || !["100644", "100755"].includes(mode!) || !/^[a-f0-9]{40}$/.test(oid!)) {
      throw new Error(`Release source contains a link, submodule or special mode: ${path}`);
    }
    files.push({ path, oid: oid!, executable: mode === "100755" });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!files.length || !Buffer.from(tree.toString("utf8")).equals(tree)) {
    throw new Error("Committed source paths are invalid");
  }
  return files;
}

/** Never walk a worktree, dependency or private ref: materialize selected committed Git blobs into a clean root. */
export async function committedSource(root: string, commit: string, destination: string): Promise<SourceManifest> {
  const files = await committedFiles(root, commit);
  mkdirSync(destination, { mode: 0o700 });
  const raw = join(dirname(destination), "committed.tar");
  await git(root, ["archive", "--format=tar", `--output=${raw}`, commit, "--", ...files.map((file) => file.path)]);
  await command(["tar", "-xf", raw, "--no-same-owner", "--no-same-permissions", "-C", destination]);
  const observed = sourceManifest(destination);
  assertSourceAdmission(observed, "upstream");
  const blobHashes = (
    await git(
      root,
      ["hash-object", "--no-filters", "--stdin-paths"],
      files.map((file) => JSON.stringify(join(destination, file.path))).join("\n") + "\n",
    )
  )
    .toString()
    .trim()
    .split("\n");
  if (
    observed.files.length !== files.length ||
    blobHashes.length !== files.length ||
    files.some(
      (file, i) =>
        blobHashes[i] !== file.oid ||
        observed.files[i]?.path !== file.path ||
        observed.files[i]?.executable !== file.executable,
    )
  ) {
    throw new Error("git archive changed committed source bytes, paths or executable modes");
  }
  return observed;
}
