import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { digest } from "../update/source.ts";
import { owned, realDirectory, regularFile } from "./files.ts";
import {
  NATIVE_UPDATE_FILES,
  prepareNativeDependencies,
  validateNativeDependencies,
} from "./native-update-dependencies.ts";
import { assertSourceBundle, bundleGit, readSourceBundle, type SourceBundle } from "./source-bundle.ts";
import { generateSourceBundle } from "./source-bundle-update.ts";
import { checkoutSourceBundle } from "./source-checkout.ts";

export type NativeCandidate = {
  readonly version: 1;
  readonly status: "candidate" | "conflict" | "held";
  readonly sourceCommit: string;
  readonly previous: string;
  readonly previousIdentity: string;
  readonly commit: string;
  readonly nativeVersion: string;
  readonly tag: string;
  readonly identity: string;
  readonly reason: string;
};
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const compareNativeVersions = (a: string, b: string): number => {
  const left = a.split(".").map(BigInt);
  const right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  return 0;
};

/** Annotated and lightweight tags are both bound to their exact peeled commit, not a mutable branch. */
export function latestNativeTag(observed: string): { tag: string; nativeVersion: string; commit: string } {
  const tags = new Map<string, { direct?: string; peeled?: string }>();
  for (const line of observed.split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{40})\trefs\/tags\/(v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)))(\^\{\})?$/.exec(
      line,
    );
    if (!match) continue;
    const entry = tags.get(match[2]!) ?? {};
    const key = match[4] ? "peeled" : "direct";
    if (entry[key]) throw new Error("Ambiguous native release tag");
    entry[key] = match[1]!;
    tags.set(match[2]!, entry);
  }
  const sorted = [...tags].sort(([a], [b]) => compareNativeVersions(b.replace(/^v/, ""), a.replace(/^v/, "")));
  const [tag, entry] = sorted[0] ?? [];
  if (!tag || !entry?.direct) throw new Error("No stable native release tag resolved");
  const nativeVersion = tag.replace(/^v/, "");
  if (sorted[1]?.[0].replace(/^v/, "") === nativeVersion) throw new Error("Ambiguous native release version");
  return { tag, nativeVersion, commit: entry.peeled ?? entry.direct };
}

/** No upstream execution: Git applies only in a private checkout and npm locks resolve with scripts disabled. */
export async function prepareNativeUpdate(
  source: string,
  output: string,
  repository?: string,
  dependencies: (
    source: string,
    output: string,
    previous: string,
    next: string,
    home: string,
  ) => void | Promise<void> = prepareNativeDependencies,
): Promise<NativeCandidate | undefined> {
  source = realpathSync(source);
  output = resolve(output);
  const before = readSourceBundle(source);
  realDirectory(dirname(output), true);
  owned(dirname(output));
  if (lstatSync(output, { throwIfNoEntry: false })) throw new Error("Native candidate output already exists");
  const home = realpathSync(mkdtempSync(join(dirname(output), ".native-update-")));
  try {
    const git = (argv: readonly string[], cwd = source) => bundleGit(argv, cwd, home);
    const sourceCommit = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
    const unchanged = async () => {
      if (
        !/^[a-f0-9]{40}$/.test(sourceCommit) ||
        (await git(["status", "--porcelain", "--untracked-files=all"])) !== "" ||
        (await git(["rev-parse", "HEAD"])) !== sourceCommit ||
        readSourceBundle(source).identity !== before.identity
      )
        throw new Error("Native update requires an exact clean committed source; preserve local changes first");
    };
    await unchanged();
    const remote = repository ?? before.lock.repository;
    const selected = latestNativeTag(await git(["ls-remote", "--tags", "--", remote]));
    if (!stable.test(before.lock.nativeVersion)) throw new Error("Invalid bound native version");
    if (selected.nativeVersion === before.lock.nativeVersion && selected.commit === before.lock.commit)
      return undefined;
    if (compareNativeVersions(selected.nativeVersion, before.lock.nativeVersion) <= 0)
      throw new Error("Native stable tag moved or would downgrade the bound release; review required");
    const staged = join(home, "bundle");
    mkdirSync(staged, { mode: 0o700 });
    const receipt = async (status: NativeCandidate["status"], reason: string, identity: string) => {
      await unchanged();
      const candidate: NativeCandidate = {
        version: 1,
        status,
        sourceCommit,
        previous: before.lock.commit,
        previousIdentity: before.identity,
        ...selected,
        identity,
        reason,
      };
      mkdirSync(output, { mode: 0o700 });
      const files = status === "candidate" ? NATIVE_UPDATE_FILES : ["conflicts.patch"];
      for (const file of files) {
        const target = join(output, file);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, readFileSync(join(staged, file)), { flag: "wx", mode: 0o600 });
      }
      writeFileSync(join(output, "candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return candidate;
    };
    const hold = (reason: string) => {
      const patch = readFileSync(before.patch);
      writeFileSync(join(staged, "conflicts.patch"), patch, { mode: 0o600 });
      return receipt("held", reason, digest(patch));
    };
    if (!/^19\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(selected.nativeVersion))
      return await hold("unsupported-runtime-major");
    const checkout = join(home, "checkout");
    await checkoutSourceBundle(checkout, before, home, remote);
    const mergePatch = join(home, "overlay-full.patch");
    await git(["diff", "--cached", "--binary", "--full-index", `--output=${mergePatch}`, "HEAD", "--"], checkout);
    await git(["fetch", "--quiet", "--no-tags", "--", remote, `refs/tags/${selected.tag}`], checkout);
    if ((await git(["rev-parse", "FETCH_HEAD^{commit}"], checkout)) !== selected.commit)
      throw new Error("Native release tag changed while preparing the candidate");
    // The old checkout is shallow. Fetch history before the ancestry proof; never accept an unrelated release.
    if ((await git(["rev-parse", "--is-shallow-repository"], checkout)) === "true")
      await git(["fetch", "--quiet", "--unshallow", "--no-tags", "--", remote, selected.commit], checkout);
    await git(["merge-base", "--is-ancestor", before.lock.commit, selected.commit], checkout);
    await git(
      ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", selected.commit],
      checkout,
    );
    const manifest = join(checkout, "packages/coding-agent/package.json");
    if (!regularFile(manifest) || JSON.parse(readFileSync(manifest, "utf8")).version !== selected.nativeVersion)
      throw new Error("Native release tag and package version differ");
    try {
      await git(["apply", "--3way", "--index", "--", mergePatch], checkout);
    } catch {
      const conflicts = join(staged, "conflicts.patch");
      // Combined conflict diffs bypass Git's --output option; redirect raw stdout without trimming patch bytes.
      await bundleGit(["diff", "--binary", "--full-index", "--"], checkout, home, conflicts);
      if (!readFileSync(conflicts).length) writeFileSync(conflicts, readFileSync(mergePatch));
      return await receipt("conflict", "three-way-apply-failed", digest(readFileSync(conflicts)));
    }
    const launcher = join(checkout, before.lock.launcher);
    if (
      !regularFile(launcher) ||
      (lstatSync(launcher).mode & 0o111) === 0 ||
      !regularFile(join(checkout, "packages/coding-agent/src/cli.ts"))
    )
      return await hold("unsupported-runtime-layout");
    const captured = await generateSourceBundle(
      checkout,
      join(staged, "native-omp.patch"),
      before.lock.repository,
      home,
    );
    const lock: SourceBundle = {
      ...captured,
      nativeVersion: selected.nativeVersion,
      launcher: before.lock.launcher,
    };
    writeFileSync(join(staged, "native-omp.lock"), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
    const bundle = readSourceBundle(staged);
    assertSourceBundle(checkout, bundle, home);
    try {
      await dependencies(source, staged, before.lock.nativeVersion, selected.nativeVersion, home);
      validateNativeDependencies(source, staged, before.lock.nativeVersion, selected.nativeVersion);
    } catch {
      return await hold("dependency-lock-refresh-failed");
    }
    return await receipt("candidate", "clean-three-way-apply", bundle.identity);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
