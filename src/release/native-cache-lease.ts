import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { platform } from "../platform/index.ts";
import { bootId, processExists, procStat } from "../update/proc.ts";
import { owned, realDirectory } from "./files.ts";
import { liveTasks } from "./process-cwd.ts";

/**
 * Shared leases and the exclusive prune lock of the native cache.
 *
 * Every writer that creates, verifies, publishes or launches an identity first leases it (`leaseNativeIdentity`), then
 * reads the prune lock; a prune claims the lock (`claimNativePrune`), then reads the leases, so one sees the other.
 */

export { scriptLeaseHolder } from "./native-lease-holder.ts";

/** A process as a lease or the lock records it. `exec` keeps all three, so a shell's lease covers what it execs. */
export type CacheHolder = { readonly pid: number; readonly startTicks: string; readonly bootId: string };

const LEASES = "native-leases";
const LOCK = "native-prune.lock";
const IDENTITY = /^[a-f0-9]{64}$/;
const LEASE = /^([1-9]\d*)-(\d+)-([A-Za-z0-9-]+)$/;
/** How long a writer waits for a running prune before it gives up. */
const WAIT_MS = 300_000;

export const nativeCacheRoot = (home: string): string => join(home, ".cache", "omp-cataly");

/** The running process `pid` as a holder; a process that is gone or a zombie cannot hold anything. */
export function cacheHolder(pid: number): CacheHolder {
  try {
    const stat = procStat(pid);
    if (Number.isSafeInteger(pid) && pid > 0 && /^\d+$/.test(stat.startTicks) && !stat.zombie)
      return { pid, startTicks: stat.startTicks, bootId: bootId() };
  } catch {
    // Reported below.
  }
  throw new Error(`Native cache holder process ${pid} is unavailable`);
}

/** Whether a recorded holder has certainly ended; what cannot be confirmed counts as still running. */
export function holderEnded(holder: CacheHolder, boot = bootId()): boolean {
  if (holder.bootId !== boot) return true;
  try {
    const stat = procStat(holder.pid);
    if (stat.startTicks !== holder.startTicks) return true;
    // A Linux thread group lives on after its leader exits (the leader then shows as a zombie).
    return stat.zombie && (!platform.procfs || liveTasks(String(holder.pid)) === undefined);
  } catch {
    try {
      return !processExists(holder.pid);
    } catch {
      return false;
    }
  }
}

export const leaseName = (holder: CacheHolder): string => `${holder.pid}-${holder.startTicks}-${holder.bootId}`;
function parseLease(name: string): CacheHolder | undefined {
  const match = LEASE.exec(name);
  return match ? { pid: Number(match[1]), startTicks: match[2]!, bootId: match[3]! } : undefined;
}

/** `native-stage-<identity>-<pid>-<start>-<boot>-XXXXXX`: a preparation of one identity by the process that owns it. */
const STAGE = /^native-stage-([a-f0-9]{64})-([1-9]\d*)-(\d+)-([A-Za-z0-9-]+)-[A-Za-z0-9]{6}$/;

/** The prefix `mkdtemp` completes for this process's preparation of `identity`. */
export const nativeStagePrefix = (identity: string): string =>
  `native-stage-${identity}-${leaseName(cacheHolder(process.pid))}-`;

/** A preparation's identity and whether its owner has ended (killed before it could clean up); undefined if unnamed. */
export function nativeStage(name: string): { readonly identity: string; readonly ended: boolean } | undefined {
  const match = STAGE.exec(name);
  if (!match) return undefined;
  return {
    identity: match[1]!,
    ended: holderEnded({ pid: Number(match[2]), startTicks: match[3]!, bootId: match[4]! }),
  };
}

/** A private directory that concurrent writers may create at the same moment. */
function directory(path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      realDirectory(path, true);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 3) throw error;
    }
  }
  owned(path);
}

/** `flock(2)` from the C library: a kernel lock its holder's death releases, so no stale lock is ever left. */
let flockSymbol: ((fd: number, operation: number) => number) | undefined;
function flock(fd: number, operation: number): boolean {
  flockSymbol ??= dlopen(platform.flockLibrary(), {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols.flock as (fd: number, operation: number) => number;
  return flockSymbol(fd, operation) === 0;
}
const [SHARED, EXCLUSIVE, NONBLOCKING, UNLOCK] = [1, 2, 4, 8];

/** The prune lock file, opened without following a link; a directory or anything else there cannot be locked. */
function openLock(cache: string): number {
  const fd = openSync(
    join(cache, LOCK),
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Native cache prune lock must be a regular file");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Whether no prune holds the lock right now; one that cannot be checked counts as held. */
function pruneIdle(cache: string): boolean {
  let fd: number;
  try {
    fd = openLock(cache);
  } catch {
    return false;
  }
  try {
    if (!flock(fd, SHARED | NONBLOCKING)) return false;
    flock(fd, UNLOCK);
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Lease `identity` for `holder` until that process ends, then wait while a prune holds the cache. Callers create,
 * verify or launch the identity only after this returns, so one a prune removed meanwhile fails their verification.
 */
export function leaseNativeIdentity(home: string, identity: string, holder = process.pid, waitMs = WAIT_MS): void {
  if (!IDENTITY.test(identity)) throw new Error(`Invalid native cache identity: ${identity}`);
  const cache = nativeCacheRoot(home);
  const leases = join(cache, LEASES, identity);
  const own = cacheHolder(holder);
  const name = leaseName(own);
  for (let attempt = 0; ; attempt++) {
    directory(leases);
    try {
      closeSync(openSync(join(leases, name), "wx", 0o600));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") break;
      // A prune removes an identity's empty lease directory; it is made again.
      if (code !== "ENOENT" || attempt >= 3) throw error;
    }
  }
  const boot = own.bootId;
  for (const other of readdirSync(leases)) {
    const ended = other === name ? undefined : parseLease(other);
    if (ended && holderEnded(ended, boot)) rmSync(join(leases, other), { force: true });
  }
  const deadline = Date.now() + waitMs;
  while (!pruneIdle(cache)) {
    if (Date.now() >= deadline)
      throw new Error(`A native cache prune holds ${join(cache, LOCK)}; retry once it has finished`);
    Bun.sleepSync(100);
  }
}

/**
 * Live leases by identity, and leases this cannot read (they keep every identity). With `sweep`, which only a prune
 * holding the lock passes, a lease whose holder ended and an emptied identity directory are removed.
 */
export function readLeases(cache: string, sweep: boolean): { byIdentity: Map<string, string[]>; unread: string[] } {
  const root = join(cache, LEASES);
  const byIdentity = new Map<string, string[]>();
  const unread: string[] = [];
  if (!lstatSync(root, { throwIfNoEntry: false })) return { byIdentity, unread };
  realDirectory(root);
  owned(root);
  const boot = bootId();
  for (const identity of readdirSync(root)) {
    const dir = join(root, identity);
    if (!IDENTITY.test(identity) || !lstatSync(dir).isDirectory()) {
      unread.push(`unrecognized lease ${dir}`);
      continue;
    }
    const held: string[] = [];
    for (const name of readdirSync(dir)) {
      const holder = parseLease(name);
      if (!holder) held.push(`unrecognized lease ${join(dir, name)}`);
      else if (!holderEnded(holder, boot)) held.push(`lease of process ${holder.pid}`);
      else if (sweep) rmSync(join(dir, name), { force: true });
    }
    if (held.length) byIdentity.set(identity, held);
    else if (sweep)
      try {
        rmdirSync(dir);
      } catch {
        // A writer leased it meanwhile; it stays.
      }
  }
  return { byIdentity, unread };
}

/**
 * Claim the prune lock for this process: an exclusive kernel lock on the lock file, which writers check for (shared)
 * after leasing. Another prune holding it, or a lock file that cannot be opened (a directory there), refuses. The
 * kernel releases it when its holder ends, however it ends; the file itself stays.
 */
export function claimNativePrune(home: string): () => void {
  const cache = nativeCacheRoot(home);
  realDirectory(cache);
  owned(cache);
  const lock = join(cache, LOCK);
  const held = new Error(`Another native cache prune holds ${lock}, or it cannot be locked; nothing was removed`);
  let fd: number;
  try {
    fd = openLock(cache);
  } catch {
    throw held;
  }
  if (!flock(fd, EXCLUSIVE | NONBLOCKING)) {
    closeSync(fd);
    throw held;
  }
  return () => {
    flock(fd, UNLOCK);
    closeSync(fd);
  };
}
