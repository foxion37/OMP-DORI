import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "../platform/index.ts";
import { digest } from "../update/source.ts";
import { realDirectory } from "./files.ts";
import { parseSourceBundleLock, readSourceBundle, type BoundBundle } from "./source-bundle.ts";

/**
 * Doctor's provenance read: the same content verification as readSourceBundle where POSIX installation metadata
 * exists. A Windows checkout carries none to enforce (every file reports group/world-writable, which an
 * installation must keep refusing), so there the lock and patch are verified by content alone for reporting.
 */
export function readSourceBundleDiagnostic(source: string): BoundBundle {
  if (platform.os !== "win32") return readSourceBundle(source);
  realDirectory(source);
  const read = (path: string, maxBytes: number): Buffer => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Missing file: ${path}`);
    if (stat.size > maxBytes) throw new Error(`Metadata is too large: ${path}`);
    return readFileSync(path);
  };
  const path = join(source, "native-omp.lock");
  const lock = read(path, 4 * 1024 * 1024);
  const value = parseSourceBundleLock(path, JSON.parse(lock.toString("utf8")));
  const patch = join(source, "native-omp.patch");
  const patchBytes = read(patch, 64 * 1024 * 1024);
  if (digest(patchBytes) !== value.patchSha256) throw new Error(`Source bundle patch digest differs: ${patch}`);
  return { lock: value, patch, identity: digest(Buffer.concat([lock, patchBytes])) };
}
