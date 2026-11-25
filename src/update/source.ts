import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UpdateError } from "./config.ts";
import { excludesSourcePath, isLocalNativeOutput } from "./source-omissions.ts";
import { catalyPin } from "./source-pin.ts";
import type { SourceEntry, SourceManifest, UpdateInputs, UpdateJob } from "./types.ts";

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

type SourceKind = "upstream" | "local" | "candidate";

/** Local credential metadata and native output may be omitted in addition to admitted Git and dependency directories. */
export function assertSourceAdmission(manifest: SourceManifest, kind: SourceKind): void {
  const omitted = manifest.excluded.filter((path) => {
    const name = path.split("/").at(-1)!;
    if (name === ".git" || (kind !== "upstream" && name === "node_modules")) return false;
    return (
      kind !== "local" ||
      !(
        path === "config.json" ||
        isLocalNativeOutput(path) ||
        [".DS_Store", ".env", "auth.json", "credentials.json"].includes(name) ||
        /^\.env\.(?!example$|sample$)/.test(name) ||
        /\.(?:pem|key|p12|pfx)$/.test(name)
      )
    );
  });
  if (omitted.length) {
    // The former omp-ulw fixture is removed before local admission; what stays in ref/ is not Cataly's.
    const ref = omitted.includes("ref") ? "; ref/ holds files Cataly did not create" : "";
    throw new UpdateError(`${kind} source admission held: ${omitted.join(", ")}${ref}`);
  }
}

/** Source only, including dirty/untracked local adaptations. Links and special files fail rather than following secrets. */
export function sourceManifest(root: string): SourceManifest {
  if (!lstatSync(root).isDirectory()) throw new UpdateError("source root must be a directory, never a link");
  const files: SourceEntry[] = [];
  const omitted: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      const path = dir ? `${dir}/${name}` : name;
      const full = join(root, path);
      const stat = lstatSync(full);
      if (excludesSourcePath(path)) {
        if ((name === ".git" || name === "node_modules" || isLocalNativeOutput(path)) && !stat.isDirectory())
          throw new UpdateError(`source metadata must be a real directory: ${path}`);
        omitted.push(path);
        continue;
      }
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile())
        files.push({ path, sha256: digest(readFileSync(full)), executable: (stat.mode & 0o111) !== 0 });
      else throw new UpdateError(`source contains a link or special file: ${path}`);
    }
  };
  visit("");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    version: 1,
    hash: digest(JSON.stringify({ files })),
    files,
    excluded: omitted.sort(),
  };
}

export const sameManifest = (observed: SourceManifest, expected: SourceManifest): boolean =>
  observed.hash === expected.hash && JSON.stringify(observed.files) === JSON.stringify(expected.files);

export function freezeSource(source: string, destination: string, kind: SourceKind = "candidate"): SourceManifest {
  const before = sourceManifest(source);
  assertSourceAdmission(before, kind);
  if (!before.files.length) throw new UpdateError("source snapshot is empty");
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const file of before.files) {
    const to = join(destination, file.path);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(source, file.path), to);
    chmodSync(to, file.executable ? 0o555 : 0o444);
  }
  const after = sourceManifest(source);
  assertSourceAdmission(after, kind);
  const frozen = sourceManifest(destination);
  assertSourceAdmission(frozen, "upstream");
  if (!sameManifest(after, before) || !sameManifest(frozen, before)) {
    throw new UpdateError("source changed while freezing; no model work started");
  }
  return before;
}

/** Every path whose bytes or mode differ between the baseline and either the local source or the new upstream. */
export function changedPaths(base: SourceManifest, local: SourceManifest, incoming: SourceManifest): string[] {
  const index = (manifest: SourceManifest): Map<string, string> => {
    const paths = new Map<string, string>();
    for (const file of manifest.files) paths.set(file.path, `${file.sha256}:${file.executable}`);
    return paths;
  };
  const [from, ours, theirs] = [index(base), index(local), index(incoming)] as const;
  return [...new Set([...from.keys(), ...ours.keys(), ...theirs.keys()])]
    .filter((path) => from.get(path) !== ours.get(path) || from.get(path) !== theirs.get(path))
    .sort();
}

export function assertFrozen(job: UpdateJob): void {
  if (!job.inputs) throw new UpdateError("missing frozen inputs");
  const recorded: unknown = JSON.parse(readFileSync(join(job.directory, "inputs", "manifest.json"), "utf8"));
  if (JSON.stringify(recorded) !== JSON.stringify(job.inputs)) throw new UpdateError("frozen input manifest changed");
  const frozen = [
    ["base", job.inputs.base],
    ["local", job.inputs.local],
    ["upstream", job.inputs.incoming],
  ] as const;
  for (const [name, manifest] of frozen) {
    assertSourceAdmission(manifest, name === "local" ? "local" : "upstream");
    const observed = sourceManifest(join(job.directory, "inputs", name));
    assertSourceAdmission(observed, "upstream");
    if (!sameManifest(observed, manifest)) throw new UpdateError(`frozen ${name} input changed`);
  }
}

/** A passed check and review only apply to the complete observed source manifest. */
export function assertSource(job: UpdateJob): void {
  assertFrozen(job);
  const source = sourceManifest(job.candidate);
  assertSourceAdmission(source, "candidate");
  if (!job.sourceHash || source.hash !== job.sourceHash) {
    throw new UpdateError("candidate source changed; earlier checks and review are stale");
  }
}

const sameCatalyPin = (local: SourceManifest, candidate: SourceManifest): boolean =>
  JSON.stringify(catalyPin(local)) === JSON.stringify(catalyPin(candidate));
/** Carry only frozen source-bundle payloads, never an old-source overlay. */
export function carryCatalyPin(local: string, candidate: string, expected: SourceManifest): void {
  for (const file of catalyPin(expected)) {
    const to = join(candidate, file.path);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(local, file.path), to);
    chmodSync(to, file.executable ? 0o755 : 0o644);
  }
  if (!sameCatalyPin(expected, sourceManifest(candidate))) {
    throw new UpdateError("prepared candidate did not preserve the frozen local source-bundle pin");
  }
}

/** Source-bundle payloads are frozen local pins, carried byte for byte by a Cataly-only port. */
export function assertCatalyScope(inputs: UpdateInputs, candidate: SourceManifest): void {
  if (!sameCatalyPin(inputs.local, candidate))
    throw new UpdateError("Cataly-only update changed the frozen source-bundle pin");
}

/** Git metadata that must not move during a port: HEAD, config, refs and the staged index (no staging, no commits). */
export function gitIdentity(candidate: string): string {
  const git = join(candidate, ".git");
  if (!lstatSync(git).isDirectory())
    throw new UpdateError("candidate must be an ordinary clone, never a linked worktree");
  const index = Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"],
    {
      cwd: candidate,
      env: {
        PATH: process.env["PATH"],
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (index.exitCode !== 0) throw new UpdateError("candidate Git index identity is unavailable");
  // Index stat-cache refreshes are harmless; staged blob/mode/stage identities must remain unchanged.
  return digest(
    [
      digest(readFileSync(join(git, "HEAD"))),
      digest(readFileSync(join(git, "config"))),
      digest(index.stdout),
      sourceManifest(join(git, "refs")).hash,
    ].join("\n"),
  );
}
