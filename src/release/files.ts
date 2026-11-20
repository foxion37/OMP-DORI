import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platform } from "../platform/index.ts";
import { contains } from "../update/config.ts";
import { processIdentity, sameProcess } from "../update/deployment-process.ts";
import type { ProcessIdentity } from "../update/deployment-types.ts";
import { saveDeploymentJson } from "../update/deployment-files.ts";
import { processExists } from "../update/proc.ts";

export type ConsumerPaths = {
  readonly home: string;
  readonly dori: string;
  readonly root: string;
  readonly live: string;
  readonly state: string;
  readonly journal: string;
  readonly config: string;
  readonly releases: string;
  readonly manifests: string;
  readonly dependencies: string;
  readonly staging: string;
  readonly links: readonly (readonly [string, string])[];
};
export const consumerPaths = (home = homedir(), doriHome = join(home, ".dori")): ConsumerPaths => {
  home = resolve(home);
  const dori = resolve(doriHome);
  const primary = join(home, ".dori");
  if (dori !== primary && (contains(primary, dori) || contains(dori, primary)))
    throw new Error("An isolated consumer home must not contain or be inside the primary ~/.dori home");
  const root = join(dori, "releases");
  return {
    home,
    dori,
    root,
    live: join(dori, "src"),
    state: join(root, "consumer-installed.json"),
    journal: join(root, "consumer-journal.json"),
    config: join(dori, "config.json"),
    releases: join(root, "releases"),
    manifests: join(root, "consumer-manifests"),
    dependencies: join(root, "consumer-dependencies"),
    staging: join(root, "consumer-staging"),
    links:
      dori !== primary
        ? []
        : ([
            [join(home, ".agents/skills/dori-mode"), join(dori, "src/skills/dori-mode")],
            [join(home, ".omp/agent/extensions/omp-dori"), join(dori, "src/extension")],
            [join(dori, "bin/dori"), join(dori, "src/skills/dori-mode/scripts/src/cli.ts")],
            [join(dori, "bin/dori-harness"), join(dori, "src/src/cli.ts")],
          ] as const),
  };
};

/** Check every existing ancestor, including dangling links, before following or creating anything. */
export function realDirectory(path: string, create = false): void {
  path = resolve(path);
  if (dirname(path) !== path) realDirectory(dirname(path), create);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) {
    if (create) mkdirSync(path, { mode: 0o700 });
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${path}; move it aside first`);
}

export function owned(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && platform.posixOwnership && stat.uid !== process.getuid?.()) throw new Error(`Different owner: ${path}`);
  if (stat && (stat.mode & 0o022) !== 0 && !stat.isSymbolicLink())
    throw new Error(
      `Group/world-writable installation path: ${path}; remove write permissions with chmod go-w, then retry`,
    );
}

export function regularFile(path: string): boolean {
  realDirectory(dirname(path));
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a real file: ${path}`);
  owned(path);
  return true;
}

/** Hash every byte through one descriptor without allocating a whole-file Buffer. */
export function fileDigest(input: string | number): string {
  const fd = typeof input === "number" ? input : openSync(input, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    if (typeof input === "string") closeSync(fd);
  }
}

export function readJson(path: string): unknown {
  if (!regularFile(path)) throw new Error(`Missing file: ${path}`);
  if (lstatSync(path).size > 4 * 1024 * 1024) throw new Error(`Metadata is too large: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveJson(path: string, value: unknown): void {
  realDirectory(dirname(path));
  regularFile(path);
  saveDeploymentJson(path, value);
}

export function syncDirectory(path: string): void {
  // Every adapter answers: Windows knows it cannot open a directory for fsync and does nothing.
  platform.syncDirectory(path);
}

export function pointer(path: string): string | undefined {
  realDirectory(dirname(path));
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  owned(path);
  if (!stat.isSymbolicLink()) throw new Error(`Unmanaged source/path: ${path}; move it aside before installing`);
  return readlinkSync(path);
}

export function replacePointer(path: string, expected: string | undefined, target: string | undefined): void {
  if (pointer(path) !== expected) throw new Error(`Installation pointer changed: ${path}`);
  if (target === undefined) {
    if (expected !== undefined) unlinkSync(path);
  } else {
    const temporary = `${path}.consumer-${randomUUID()}`;
    symlinkSync(target, temporary);
    try {
      if (pointer(path) !== expected) throw new Error(`Installation pointer changed: ${path}`);
      renameSync(temporary, path);
    } finally {
      if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary);
    }
  }
  syncDirectory(dirname(path));
}

export function initialize(paths: ConsumerPaths): void {
  for (const dir of [
    paths.home,
    paths.dori,
    paths.root,
    paths.releases,
    paths.manifests,
    paths.dependencies,
    paths.staging,
  ]) {
    realDirectory(dir, true);
    owned(dir);
  }
  const owner = join(paths.root, "consumer-owner.json");
  const receipt = { version: 1, home: paths.home, liveSource: paths.live };
  if (!regularFile(owner)) writeFileSync(owner, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  if (JSON.stringify(readJson(owner)) !== JSON.stringify(receipt))
    throw new Error("Consumer release ownership differs");
}

export class ConsumerLockBusy extends Error {}

/** A dead holder may be recovered; incomplete or live lock ownership always holds. */
export function acquireConsumerLock(
  paths: ConsumerPaths,
  name: "consumer.lock" | "consumer-launch.lock" = "consumer.lock",
): () => void {
  const lock = join(paths.root, name);
  const identity = processIdentity(process.pid);
  if (!identity) throw new Error("Consumer process identity is unavailable");
  const claim = () => {
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner.json"), JSON.stringify(identity), { flag: "wx", mode: 0o600 });
  };
  try {
    claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    realDirectory(lock);
    owned(lock);
    const owner = join(lock, "owner.json");
    if (!regularFile(owner)) throw new ConsumerLockBusy("Consumer release lock is held; its owner is being recorded");
    let holder: Partial<ProcessIdentity>;
    try {
      holder = readJson(owner) as Partial<ProcessIdentity>;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        !lstatSync(owner, { throwIfNoEntry: false })
      )
        throw new ConsumerLockBusy("Consumer release lock is held; its owner is incomplete");
      throw error;
    }
    if (
      !holder ||
      typeof holder !== "object" ||
      !Number.isSafeInteger(holder.pid) ||
      holder.pid! <= 0 ||
      typeof holder.startTicks !== "string" ||
      typeof holder.bootId !== "string" ||
      typeof holder.executable !== "string" ||
      sameProcess(holder as ProcessIdentity) ||
      (!processIdentity(holder.pid!) && processExists(holder.pid!))
    )
      throw new ConsumerLockBusy("Consumer release lock is held; let its owner finish");
    const stale = createHash("sha256")
      .update(JSON.stringify([holder.pid, holder.startTicks, holder.bootId, holder.executable]))
      .digest("hex");
    // Never delete, rename, or reuse this nonempty tombstone: it reserves the observed identity
    // so a delayed contender cannot move a newer live lock over it.
    try {
      renameSync(lock, `${lock}.stale-${stale}`);
      claim();
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new ConsumerLockBusy("Consumer release lock is held; another owner recovered it");
      throw error;
    }
  }
  return () => {
    const holder = readJson(join(lock, "owner.json")) as ProcessIdentity;
    if (!sameProcess(identity, holder)) throw new Error("Consumer release lock ownership changed");
    unlinkSync(join(lock, "owner.json"));
    rmdirSync(lock);
  };
}
