import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonical, contains, UpdateError } from "./config.ts";
import { digest, sameManifest } from "./source.ts";
import type { SourceEntry, SourceManifest, UpdateContext, UpdateJob } from "./types.ts";

/** Authentication, client settings and checkouts are never application data, whatever directory holds them. */
const PRIVATE_NAMES: Readonly<Record<string, true>> = {
  ".git": true,
  node_modules: true,
  ".dori": true,
  ".omp": true,
  ".omo": true,
  auth: true,
  oauth: true,
  "auth.json": true,
  "credentials.json": true,
  "config.json": true,
  "settings.json": true,
};
const isPrivate = (name: string): boolean =>
  PRIVATE_NAMES[name] === true || /^\.env(?:\.|$)/.test(name) || /\.(?:key|pem|p12|pfx)$/.test(name);

/** Application data has its own admission policy: lane/session metadata, receipts, monitors and cursors ARE state. */
export function applicationManifest(root: string): SourceManifest {
  if (!lstatSync(root).isDirectory()) throw new UpdateError("application state must be a real directory, never a link");
  const files: SourceEntry[] = [];
  const excluded: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      const path = dir ? `${dir}/${name}` : name;
      if (isPrivate(name)) {
        excluded.push(path);
        continue;
      }
      const full = join(root, path);
      const stat = lstatSync(full);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile())
        files.push({ path, sha256: digest(readFileSync(full)), executable: (stat.mode & 0o111) !== 0 });
      else throw new UpdateError("application state contains a link or special file");
    }
  };
  visit("");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: 1, hash: digest(JSON.stringify(files)), files, excluded: excluded.sort() };
}

/** The explicit task-owned data directory. Never inferred, never source, never model authentication. */
export function applicationInput(ctx: UpdateContext, job: UpdateJob, input: string): string {
  const source = canonical(resolve(input));
  const root = ctx.config.root;
  if (contains(source, root) || contains(join(root, "jobs"), source)) {
    throw new UpdateError("application-state input must not contain the updater root or live inside a job directory");
  }
  const protectedPaths = [
    ctx.config.localSource,
    job.candidate,
    join(job.directory, "inputs"),
    ...(ctx.config.modelAgentDir ? [ctx.config.modelAgentDir] : []),
  ].map(canonical);
  if (protectedPaths.some((path) => contains(path, source) || contains(source, path))) {
    throw new UpdateError(
      "application-state input must be separate from source, frozen inputs and model authentication",
    );
  }
  if (!contains(root, source)) {
    for (const name of [".dori", ".omp", ".agents"]) {
      const personal = canonical(join(homedir(), name));
      if (contains(personal, source) || contains(source, personal)) {
        throw new UpdateError("application-state input must be explicitly task-owned, outside personal Dori/OMP state");
      }
    }
  }
  return source;
}

export function freezeApplicationState(source: string, output: string): SourceManifest {
  const manifest = applicationManifest(source);
  if (!manifest.files.length) throw new UpdateError("application-state snapshot has no admitted application data");
  mkdirSync(output, { mode: 0o700 });
  for (const file of manifest.files) {
    const to = join(output, file.path);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(source, file.path), to);
    chmodSync(to, file.executable ? 0o555 : 0o444);
  }
  if (!sameManifest(applicationManifest(source), manifest) || !sameManifest(applicationManifest(output), manifest)) {
    throw new UpdateError("application state changed while snapshotting; stop its candidate processes before retrying");
  }
  return manifest;
}

export function restoreApplicationState(input: string, output: string, manifest: SourceManifest): void {
  if (!sameManifest(applicationManifest(input), manifest))
    throw new UpdateError("application-state snapshot hash mismatch");
  mkdirSync(output, { mode: 0o700 });
  for (const file of manifest.files) {
    const to = join(output, file.path);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(input, file.path), to);
    chmodSync(to, file.executable ? 0o700 : 0o600);
  }
  if (!sameManifest(applicationManifest(output), manifest))
    throw new UpdateError("restored application-state hash mismatch");
}
