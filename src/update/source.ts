import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UpdateError } from "./config.ts";
import type { SourceEntry, SourceManifest, UpdateInputs, UpdateJob } from "./types.ts";

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

/** Excluded metadata/secrets are never copied; admission separately holds excluded code before it can execute. */
const OMIT: Readonly<Record<string, true>> = {
  ".git": true,
  node_modules: true,
  ".dori": true,
  ".omp": true,
  ".omo": true,
  ".cache": true,
  ".DS_Store": true,
  ".env": true,
  "auth.json": true,
  "credentials.json": true,
};
const ROOT_RUNTIME: Readonly<Record<string, true>> = {
  "config.json": true,
  state: true,
  sessions: true,
  auth: true,
  bin: true,
  cache: true,
  tmp: true,
  globalextensions: true,
  ref: true,
  ".qa-home": true,
  evidence: true,
};
const ULW_LIBRARY = "ref/omp-ulw";
const excluded = (path: string): boolean => {
  const parts = path.split("/");
  const library = path === ULW_LIBRARY || path.startsWith(`${ULW_LIBRARY}/`);
  if (parts[0] === "ref" && path !== "ref" && !library) return true;
  const relative = library ? parts.slice(2) : parts;
  return (
    (path !== "ref" && ROOT_RUNTIME[relative[0] ?? ""] === true) ||
    parts.some(
      (part) =>
        OMIT[part] === true ||
        (library && (part === "auth" || part === "credentials")) ||
        /^\.env\.(?!example$|sample$)/.test(part) ||
        /\.(?:pem|key|p12|pfx|tmp)$/.test(part),
    )
  );
};

type SourceKind = "upstream" | "local" | "candidate";

/** Only explicit local credential metadata may be omitted in addition to Git and installed dependencies. */
export function assertSourceAdmission(manifest: SourceManifest, kind: SourceKind): void {
  const omitted = manifest.excluded.filter((path) => {
    const name = path.split("/").at(-1)!;
    if (name === ".git" || (kind !== "upstream" && name === "node_modules")) return false;
    return (
      kind !== "local" ||
      !(
        path === "config.json" ||
        [".DS_Store", ".env", "auth.json", "credentials.json"].includes(name) ||
        /^\.env\.(?!example$|sample$)/.test(name) ||
        /\.(?:pem|key|p12|pfx)$/.test(name) ||
        (path.startsWith(`${ULW_LIBRARY}/`) && (name === "auth" || name === "credentials"))
      )
    );
  });
  if (omitted.length) throw new UpdateError(`${kind} source admission held: ${omitted.join(", ")}`);
}

/** Source only, including dirty/untracked local adaptations. Links and special files fail rather than following secrets. */
export function sourceManifest(root: string): SourceManifest {
  if (!lstatSync(root).isDirectory()) throw new UpdateError("source root must be a directory, never a link");
  const files: SourceEntry[] = [];
  const omitted: string[] = [];
  let ulwPresent = false;
  const visit = (dir: string): void => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      const path = dir ? `${dir}/${name}` : name;
      const full = join(root, path);
      const stat = lstatSync(full);
      if (excluded(path)) {
        if ((name === ".git" || name === "node_modules") && !stat.isDirectory())
          throw new UpdateError(`source metadata must be a real directory: ${path}`);
        omitted.push(path);
        continue;
      }
      if ((path === "ref" || path === ULW_LIBRARY) && !stat.isDirectory()) {
        throw new UpdateError(`source library path must be a real directory: ${path}`);
      }
      if (path === ULW_LIBRARY) ulwPresent = true;
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
    hash: digest(JSON.stringify({ files, ulwPresent })),
    files,
    excluded: omitted.sort(),
    ulwPresent,
  };
}

export const sameManifest = (observed: SourceManifest, expected: SourceManifest): boolean =>
  observed.hash === expected.hash &&
  observed.ulwPresent === expected.ulwPresent &&
  JSON.stringify(observed.files) === JSON.stringify(expected.files);

export function freezeSource(source: string, destination: string, kind: SourceKind = "candidate"): SourceManifest {
  const before = sourceManifest(source);
  assertSourceAdmission(before, kind);
  if (!before.files.length) throw new UpdateError("source snapshot is empty");
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  if (before.ulwPresent) mkdirSync(join(destination, ULW_LIBRARY), { recursive: true, mode: 0o700 });
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
    paths.set(`${ULW_LIBRARY}/`, manifest.ulwPresent ? "present" : "absent");
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
    if (!sameManifest(observed, manifest)) {
      throw new UpdateError(`frozen ${name} input changed`);
    }
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

const doriPin = (manifest: SourceManifest): readonly SourceEntry[] =>
  manifest.files.filter((file) => file.path === "omp-ulw.lock" || file.path.startsWith(`${ULW_LIBRARY}/`));

const sameDoriPin = (local: SourceManifest, candidate: SourceManifest): boolean =>
  local.ulwPresent === candidate.ulwPresent && JSON.stringify(doriPin(local)) === JSON.stringify(doriPin(candidate));

/** Carry only the frozen local pin, never an old-source overlay or a library fetch/update. */
export function carryDoriPin(local: string, candidate: string, expected: SourceManifest): void {
  const incoming = sourceManifest(candidate);
  const library = (manifest: SourceManifest): readonly SourceEntry[] =>
    manifest.files.filter((file) => file.path.startsWith(`${ULW_LIBRARY}/`));
  if (
    (incoming.ulwPresent &&
      (!expected.ulwPresent || JSON.stringify(library(incoming)) !== JSON.stringify(library(expected)))) ||
    (!expected.files.some((file) => file.path === "omp-ulw.lock") &&
      incoming.files.some((file) => file.path === "omp-ulw.lock"))
  ) {
    throw new UpdateError("new upstream conflicts with the frozen local ULW lock/library; Dori-only staging held");
  }
  if (expected.ulwPresent) mkdirSync(join(candidate, ULW_LIBRARY), { recursive: true, mode: 0o700 });
  for (const file of doriPin(expected)) {
    const to = join(candidate, file.path);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(local, file.path), to);
    chmodSync(to, file.executable ? 0o755 : 0o644);
  }
  if (!sameDoriPin(expected, sourceManifest(candidate))) {
    throw new UpdateError("prepared candidate did not preserve the frozen local ULW lock/library");
  }
}

/** The ULW lock/library is a frozen local pin; a Dori-only port must carry it over byte for byte. */
export function assertDoriScope(inputs: UpdateInputs, candidate: SourceManifest): void {
  if (!sameDoriPin(inputs.local, candidate)) {
    throw new UpdateError("Dori-only update changed the frozen ULW lock/library");
  }
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
