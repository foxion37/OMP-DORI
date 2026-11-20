import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileDigest, owned, realDirectory, regularFile } from "./release/files.ts";
import { saveDeploymentText } from "./update/deployment-files.ts";
import { digest } from "./update/source.ts";

export type SetupSnapshot = {
  readonly path: string;
  readonly stamp: string | null;
  readonly sha256: string | null;
  readonly mode: number;
  readonly gid: number | null;
};

export class SetupConflict extends Error {}

function observeSetupFile(input: string, hash: (fd: number) => string): SetupSnapshot {
  const path = resolve(input);
  realDirectory(dirname(path));
  owned(dirname(path));
  if (!regularFile(path)) return { path, stamp: null, sha256: null, mode: 0o600, gid: null };
  const changed = () =>
    new SetupConflict(`Configuration changed while being read: ${path}; rerun setup after the edit finishes`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && !regularFile(path)) throw changed();
    throw error;
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    const stamp = (stat: typeof before) =>
      [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    const assertOwnedFile = (stat: typeof before) => {
      if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== BigInt(process.getuid())))
        throw new Error(`Owned regular configuration required: ${path}`);
      if ((stat.mode & 0o022n) !== 0n)
        throw new Error(
          `Group/world-writable configuration: ${path}; remove write permissions with chmod go-w, then rerun --preview`,
        );
    };
    assertOwnedFile(before);
    const sha256 = hash(fd);
    const after = fstatSync(fd, { bigint: true });
    assertOwnedFile(after);
    realDirectory(dirname(path));
    owned(dirname(path));
    const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (current) assertOwnedFile(current);
    if (!current || stamp(before) !== stamp(after) || stamp(before) !== stamp(current)) throw changed();
    return {
      path,
      stamp: stamp(before),
      sha256,
      mode: Number(before.mode & 0o7777n),
      gid: Number(before.gid),
    };
  } finally {
    closeSync(fd);
  }
}

/** No file content or credentials enter the setup snapshot. */
export function captureSetupFile(input: string): SetupSnapshot {
  return observeSetupFile(input, fileDigest);
}

function assertSameSetupFile(snapshot: SetupSnapshot, current: SetupSnapshot): void {
  if (
    current.stamp !== snapshot.stamp ||
    current.sha256 !== snapshot.sha256 ||
    current.mode !== snapshot.mode ||
    current.gid !== snapshot.gid
  )
    throw new SetupConflict(
      `Configuration changed during setup: ${snapshot.path}; keep the edit and rerun --preview before installing`,
    );
}

export function assertSetupFile(snapshot: SetupSnapshot): void {
  assertSameSetupFile(snapshot, captureSetupFile(snapshot.path));
}

/** Read and hash the same descriptor bytes; callers parse this buffer, not a second pathname read. */
export function readSetupFile(snapshot: SetupSnapshot): Buffer | undefined {
  let bytes: Buffer | undefined;
  const current = observeSetupFile(snapshot.path, (fd) => {
    bytes = readFileSync(fd);
    return digest(bytes);
  });
  assertSameSetupFile(snapshot, current);
  return bytes;
}

export function setupPreview(snapshot: SetupSnapshot, text: string | Buffer, managedKeys: readonly string[]) {
  const afterSha256 = digest(text);
  return {
    path: snapshot.path,
    action: snapshot.stamp === null ? "create" : afterSha256 === snapshot.sha256 ? "preserve" : "update",
    beforeSha256: snapshot.sha256,
    afterSha256,
    managedKeys,
    unknownKeys: "preserved",
  };
}

/** Existing files use optimistic CAS immediately before rename; absent files use atomic no-clobber creation. */
export function publishSetupFile(snapshot: SetupSnapshot, text: string | Buffer): SetupSnapshot {
  assertSetupFile(snapshot);
  const expected = digest(text);
  if (expected === snapshot.sha256) return snapshot;
  realDirectory(dirname(snapshot.path), true);
  owned(dirname(snapshot.path));
  saveDeploymentText(snapshot.path, text, {
    mode: snapshot.mode,
    ...(snapshot.gid === null ? {} : { gid: snapshot.gid }),
    createOnly: snapshot.stamp === null,
    beforePublish: () => assertSetupFile(snapshot),
  });
  const observed = captureSetupFile(snapshot.path);
  if (
    observed.sha256 !== expected ||
    observed.mode !== snapshot.mode ||
    (snapshot.gid !== null && observed.gid !== snapshot.gid)
  )
    throw new Error(
      `Configuration readback differs after publication: ${snapshot.path}; inspect the current file before retrying`,
    );
  return observed;
}
