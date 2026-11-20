import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { digest } from "../update/source.ts";
import type { SourceEntry } from "../update/types.ts";
import { owned, realDirectory, regularFile } from "./files.ts";
import { assertSourceBundle, bundleGit, readSourceBundle, type SourceBundle } from "./source-bundle.ts";
import { checkoutSourceBundle } from "./source-checkout.ts";

export const ULW_UPDATE_FILES = ["omp-ulw.lock", "omp-ulw.overlay.lock", "omp-ulw.patch"] as const;
const SHA = /^[a-f0-9]{40}$/;
export type UlwCandidate = {
  readonly version: 1;
  readonly sourceCommit: string;
  readonly previous: string;
  readonly previousIdentity: string;
  readonly commit: string;
  readonly identity: string;
};

/** Metadata only: preparing a candidate never executes upstream code or writes the source/installed caches. */
export async function prepareUlwUpdate(
  source: string,
  output: string,
  repository?: string,
): Promise<UlwCandidate | undefined> {
  source = realpathSync(source);
  output = resolve(output);
  const before = readSourceBundle(source);
  if (
    !regularFile(join(source, "omp-ulw.lock")) ||
    readFileSync(join(source, "omp-ulw.lock"), "utf8").trim() !== before.lock.commit
  )
    throw new Error("ULW source pin and overlay differ");
  realDirectory(dirname(output), true);
  owned(dirname(output));
  if (lstatSync(output, { throwIfNoEntry: false })) throw new Error("ULW candidate output already exists");
  const temporary = realpathSync(mkdtempSync(join(dirname(output), ".ulw-update-")));
  try {
    const git = (argv: readonly string[], cwd = source) => bundleGit(argv, cwd, temporary);
    const sourceCommit = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!SHA.test(sourceCommit)) throw new Error("ULW update requires a committed Dori source");
    for (const file of ULW_UPDATE_FILES) {
      if ((await git(["hash-object", "--no-filters", "--", file])) !== (await git(["rev-parse", `HEAD:${file}`])))
        throw new Error("ULW bundle has local changes; preserve them before automatic preparation");
    }
    const remote = repository ?? before.lock.repository;
    const observed = await git(["ls-remote", "--exit-code", "--refs", "--", remote, "refs/heads/main"]);
    const match = /^([a-f0-9]{40})\trefs\/heads\/main$/.exec(observed);
    if (!match?.[1]) throw new Error("ULW main did not resolve to one exact commit");
    const commit = match[1];
    if (commit === before.lock.commit) return undefined;
    const checkout = join(temporary, "checkout");
    await checkoutSourceBundle(checkout, before, temporary, remote);
    // Normalize legacy unified patches into full blob identities before three-way application.
    // All writes occur in this private checkout; the original bound overlay was already verified.
    const mergePatch = join(temporary, "overlay-full.patch");
    await git(["diff", "--cached", "--binary", "--full-index", `--output=${mergePatch}`, "HEAD", "--"], checkout);
    await git(["fetch", "--quiet", "--no-tags", "--", remote, commit], checkout);
    await git(["merge-base", "--is-ancestor", before.lock.commit, commit], checkout);
    await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", commit], checkout);
    try {
      await git(["apply", "--3way", "--index", "--", mergePatch], checkout);
    } catch {
      const conflicts = (await git(["diff", "--name-only", "--diff-filter=U", "-z", "--"], checkout))
        .split("\0")
        .filter(Boolean);
      throw new Error(
        `ULW overlay needs a reviewed port: automatic three-way application failed${
          conflicts.length ? ` with conflicts in ${JSON.stringify(conflicts)}` : ""
        }; installed/source pins unchanged`,
      );
    }
    const patchPath = join(temporary, "omp-ulw.patch");
    await git(["diff", "--cached", "--binary", "--full-index", `--output=${patchPath}`, "HEAD", "--"], checkout);
    const patch = readFileSync(patchPath);
    if (!patch.length) throw new Error("ULW overlay is now empty; a reviewed no-overlay migration is required");
    const raw = await git(["diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z", "HEAD", "--"], checkout);
    const entries = raw.split("\0");
    if (entries.pop() !== "" || entries.length % 2) throw new Error("Invalid ULW postimage listing");
    const files: SourceEntry[] = [];
    for (let i = 0; i < entries.length; i += 2) {
      const entry = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} [AMDT]$/.exec(entries[i]!);
      const path = entries[i + 1]!;
      if (!entry) throw new Error("Invalid ULW overlay change");
      if (entry[2] === "000000") continue;
      if (!/^(100644|100755)$/.test(entry[2]!)) throw new Error("ULW overlay changes a non-regular file");
      const actual = join(checkout, path);
      const stat = lstatSync(actual);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ULW overlay postimage is not a regular file");
      files.push({ path, sha256: digest(readFileSync(actual)), executable: entry[2] === "100755" });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const lock: SourceBundle = {
      version: 1,
      repository: before.lock.repository,
      commit,
      patchSha256: digest(patch),
      resultTree: await git(["write-tree"], checkout),
      files,
    };
    const staged = join(temporary, "bundle");
    mkdirSync(staged, { mode: 0o700 });
    writeFileSync(join(staged, "omp-ulw.lock"), `${commit}\n`, { mode: 0o600 });
    writeFileSync(join(staged, "omp-ulw.overlay.lock"), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(staged, "omp-ulw.patch"), patch, { mode: 0o600 });
    const bundle = readSourceBundle(staged);
    assertSourceBundle(checkout, bundle, temporary);
    if (
      readSourceBundle(source).identity !== before.identity ||
      readFileSync(join(source, "omp-ulw.lock"), "utf8").trim() !== before.lock.commit ||
      (await git(["rev-parse", "HEAD"])) !== sourceCommit
    )
      throw new Error("Dori source changed while preparing the ULW candidate");
    const candidate: UlwCandidate = {
      version: 1,
      sourceCommit,
      previous: before.lock.commit,
      previousIdentity: before.identity,
      commit,
      identity: bundle.identity,
    };
    mkdirSync(output, { mode: 0o700 });
    for (const file of ULW_UPDATE_FILES)
      writeFileSync(join(output, file), readFileSync(join(staged, file)), { flag: "wx", mode: 0o600 });
    writeFileSync(join(output, "candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return candidate;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
