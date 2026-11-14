import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { dlopen } from "bun:ffi";
import { DeploymentHeld } from "./deployment-process.ts";
import type { DeploymentConfig, PointerRecord } from "./deployment-types.ts";
import { digest } from "./source.ts";

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Darwin link(2) follows symlinks; rollback must preserve the link inode itself. */
function preserveLink(path: string, backup: string): void {
  if (process.platform !== "darwin") {
    linkSync(path, backup);
    return;
  }
  const native = dlopen("/usr/lib/libSystem.B.dylib", {
    linkat: { args: ["i32", "ptr", "i32", "ptr", "i32"], returns: "i32" },
  } as const);
  try {
    // Darwin AT_FDCWD is -2; flags=0 excludes AT_SYMLINK_FOLLOW.
    if (native.symbols.linkat(-2, Buffer.from(`${path}\0`), -2, Buffer.from(`${backup}\0`), 0) !== 0)
      throw new DeploymentHeld("installation pointer inode could not be preserved");
  } finally {
    native.close();
  }
}

export function saveDeploymentJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncDirectory(dirname(path));
}

export function ownReleaseRoot(config: DeploymentConfig): void {
  mkdirSync(config.releaseRoot, { recursive: true, mode: 0o700 });
  if (!lstatSync(config.releaseRoot).isDirectory()) throw new DeploymentHeld("release root must be a real directory");
  const path = join(config.releaseRoot, "owner.json");
  const owner = digest(JSON.stringify({ home: config.home, liveSource: config.liveSource, stateDir: config.stateDir }));
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    if (readdirSync(config.releaseRoot).length !== 0) throw new DeploymentHeld("release root has no ownership receipt");
    writeFileSync(path, JSON.stringify({ version: 1, owner }), { flag: "wx", mode: 0o600 });
  }
  const receipt = JSON.parse(readFileSync(path, "utf8")) as { version?: number; owner?: string };
  if (receipt.version !== 1 || receipt.owner !== owner) throw new DeploymentHeld("release root ownership differs");
  mkdirSync(join(config.releaseRoot, "releases"), { recursive: true, mode: 0o700 });
  mkdirSync(join(config.releaseRoot, "transactions"), { recursive: true, mode: 0o700 });
}

/** Capture inode identities and owned rollback names before the first stop or rename. */
export function capturePointer(path: string, target: string, id: string): PointerRecord {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink())
    throw new DeploymentHeld("installation pointer is a special file");
  if (stat && process.getuid !== undefined && stat.uid !== process.getuid())
    throw new DeploymentHeld("installation pointer belongs to another owner");
  const original = stat
    ? {
        dev: stat.dev,
        ino: stat.ino,
        kind: stat.isSymbolicLink()
          ? ("link" as const)
          : stat.isDirectory()
            ? ("directory" as const)
            : ("file" as const),
        ...(stat.isSymbolicLink() ? { target: readlinkSync(path) } : {}),
      }
    : undefined;
  const prefix = join(dirname(path), `.${basename(path)}.dori-${id}`);
  if (
    lstatSync(`${prefix}.previous`, { throwIfNoEntry: false }) ||
    lstatSync(`${prefix}.failed`, { throwIfNoEntry: false })
  )
    throw new DeploymentHeld("rollback pointer name already exists");
  return {
    path,
    target,
    backup: `${prefix}.previous`,
    displaced: `${prefix}.failed`,
    ...(original ? { original } : {}),
  };
}

function originalAt(pointer: PointerRecord, path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return (
    stat !== undefined &&
    pointer.original !== undefined &&
    stat.dev === pointer.original.dev &&
    stat.ino === pointer.original.ino
  );
}
function desiredAt(pointer: PointerRecord): boolean {
  const stat = lstatSync(pointer.path, { throwIfNoEntry: false });
  return stat?.isSymbolicLink() === true && readlinkSync(pointer.path) === pointer.target;
}

/** Reconcile every possible interruption between preserving the old inode and installing the stable link. */
export function switchPointer(pointer: PointerRecord): void {
  const backup = lstatSync(pointer.backup, { throwIfNoEntry: false });
  if (backup && !originalAt(pointer, pointer.backup)) throw new DeploymentHeld("rollback pointer identity changed");
  if (desiredAt(pointer) && (!pointer.original || backup)) return;
  const current = lstatSync(pointer.path, { throwIfNoEntry: false });
  if (current) {
    if (!originalAt(pointer, pointer.path)) throw new DeploymentHeld("live pointer changed before switch");
    if (!backup) {
      if (pointer.original?.kind === "directory") renameSync(pointer.path, pointer.backup);
      else preserveLink(pointer.path, pointer.backup);
    }
  } else if (pointer.original && !backup) throw new DeploymentHeld("original installation disappeared");
  const temporary = `${pointer.path}.next-${randomUUID()}`;
  mkdirSync(dirname(pointer.path), { recursive: true, mode: 0o700 });
  symlinkSync(pointer.target, temporary);
  // Cooperating restart/switch writers hold the shared identity-bound directory lock.
  const latest = lstatSync(pointer.path, { throwIfNoEntry: false });
  if (latest && (!originalAt(pointer, pointer.path) || latest.isDirectory()))
    throw new DeploymentHeld("live pointer changed during switch");
  renameSync(temporary, pointer.path);
  syncDirectory(dirname(pointer.path));
}

/** Never delete old source, old shims, or failed source pointers. Rollback restores the exact old inode. */
export function restorePointer(pointer: PointerRecord): void {
  if (originalAt(pointer, pointer.path)) return;
  const current = lstatSync(pointer.path, { throwIfNoEntry: false });
  if (current) {
    if (!desiredAt(pointer)) throw new DeploymentHeld("live pointer changed before rollback");
    const displaced = lstatSync(pointer.displaced, { throwIfNoEntry: false });
    if (displaced && (displaced.dev !== current.dev || displaced.ino !== current.ino))
      throw new DeploymentHeld("failed pointer backup identity changed");
    if (!displaced) {
      if (pointer.original && pointer.original.kind !== "directory") preserveLink(pointer.path, pointer.displaced);
      else renameSync(pointer.path, pointer.displaced);
    }
  }
  if (pointer.original) {
    if (!originalAt(pointer, pointer.backup)) throw new DeploymentHeld("original rollback inode is unavailable");
    renameSync(pointer.backup, pointer.path);
  }
  syncDirectory(dirname(pointer.path));
}
