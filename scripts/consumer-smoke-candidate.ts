import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { realDirectory } from "../src/release/files.ts";
import { publicReleasePath } from "../src/release/manifest.ts";
import { digest } from "../src/update/source.ts";
import { packageReleaseTree } from "./release-build.ts";
import { nativeHosts, nativeReleasePath } from "./release-native.ts";
import { git } from "./release-process.ts";

/** Local consumer smoke only: dirty bytes go in an isolated Git tree, never in a commit or release publication. */
async function packageCandidate(root: string, scratch: string, dist: string) {
  const base = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
  const raw = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const text = raw.toString("utf8");
  assert(Buffer.from(text).equals(raw), "Working tree includes non-UTF-8 paths");
  const paths = [...new Set(text.split("\0").filter(Boolean))].filter(publicReleasePath).sort();
  mkdirSync(scratch, { mode: 0o700 });
  const expected = [];
  for (const path of paths) {
    const from = join(root, path);
    realDirectory(dirname(from));
    const stat = lstatSync(from, { throwIfNoEntry: false });
    if (!stat) continue; // A tracked deletion in the current working tree.
    assert(stat.isFile() && !stat.isSymbolicLink(), `Special path in local smoke candidate: ${path}`);
    const to = join(scratch, path);
    const bytes = readFileSync(from);
    const executable = (stat.mode & 0o111) !== 0;
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    writeFileSync(to, bytes, { flag: "wx" });
    chmodSync(to, executable ? 0o755 : 0o644);
    expected.push({ path, executable, sha256: digest(bytes) });
  }
  await git(scratch, ["init", "--quiet"]);
  await git(scratch, ["add", "--force", "--", "."]);
  const tree = (await git(scratch, ["write-tree"])).toString().trim();
  // A local fixture deliberately cannot resolve as a public tag/commit, even when its source bytes match HEAD.
  const commit = digest(`consumer-smoke-local-tree:${base}:${tree}`).slice(0, 40);
  const manifest = await packageReleaseTree({ root: scratch, commit, tree }, dist, true);
  const native = new Set(nativeHosts.map(nativeReleasePath));
  assert.deepEqual(
    manifest.source.files.filter((entry) => !native.has(entry.path)),
    expected,
    "Local candidate tree changed the captured working bytes",
  );
  return { base, tree, commit, sourceHash: manifest.source.hash, kind: "working-tree-qa-only" };
}

if (import.meta.main) {
  const [root, scratch, dist] = process.argv.slice(2);
  assert(root && scratch && dist && [root, scratch, dist].every(isAbsolute), "Requires three absolute paths");
  console.log(JSON.stringify(await packageCandidate(root, scratch, dist)));
}
