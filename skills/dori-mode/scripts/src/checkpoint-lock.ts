import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";

/** A write holds the lock for milliseconds, so a lock this old was left behind even if its pid is alive again (pid reuse). */
export const LOCK_STALE_MS = 2 * 60_000;
type LockOwner = { readonly pid: number; readonly host: string; readonly at: string; readonly nonce: string };
type LockSeen = { readonly raw: string | null; readonly ino: number; readonly mtimeMs: number };

// raw is null for the lock directory an earlier build used; null overall when there is no lock.
const inspect = (lock: string): LockSeen | null => {
  try {
    const stat = statSync(lock);
    return { raw: stat.isDirectory() ? null : readFileSync(lock, "utf8"), ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
const ownerOf = (raw: string | null): LockOwner | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LockOwner> | null;
    return typeof v?.pid === "number" &&
      typeof v.host === "string" &&
      typeof v.at === "string" &&
      typeof v.nonce === "string"
      ? (v as LockOwner)
      : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null; // a writer stopped between creating the lock and writing its record
  }
};
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Take the writer lock at `lock` and return its release, or why another writer holds it. The lock file records pid,
 * host, time and a nonce. A live writer's lock is not taken. A lock whose pid is dead on this host, or that is
 * LOCK_STALE_MS old, is taken over: so a writer killed mid-write never locks the file. A lock with no owner record or
 * an unreadable time is aged by its mtime. `fail` builds the error for a lock that could not be put back.
 * `keepLiveOwner`: a lock whose owner is alive on this host is never taken over by age, for locks held across pane
 * round trips that may outlast LOCK_STALE_MS; a reused pid then holds it until that process ends.
 */
export const takeLock = (
  lock: string,
  now: number,
  fail: (message: string) => Error,
  opts: { readonly keepLiveOwner?: boolean } = {},
): (() => void) | string => {
  const record = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    at: new Date(now).toISOString(),
    nonce: randomUUID(),
  } satisfies LockOwner);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, record);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // A lock taken over after LOCK_STALE_MS belongs to its new owner; leave it. Move the lock aside first, so no
      // takeover can land between the ownership check and the removal, and remove it only if its record is ours.
      return () => {
        const aside = `${lock}.${process.pid}.${randomUUID()}.release`;
        try {
          renameSync(lock, aside);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (inspect(aside)?.raw === record) {
          rmSync(aside, { force: true });
          return;
        }
        // Another writer's lock: put it back without replacing a newer one, and never delete it.
        try {
          linkSync(aside, lock);
        } catch (error) {
          throw fail(
            `belongs to another writer and could not be put back; it is at ${aside}: ${(error as Error).message}`,
          );
        }
        rmSync(aside, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const seen = inspect(lock);
    if (!seen) continue;
    const owner = ownerOf(seen.raw);
    const at = owner ? Date.parse(owner.at) : NaN;
    const since = Number.isFinite(at) ? at : seen.mtimeMs;
    const local = owner !== null && owner.host === hostname();
    const dead = local && !alive(owner.pid);
    // A lock held across slow I/O keeps a live local owner however old it is; only death releases it.
    const kept = opts.keepLiveOwner === true && local && !dead;
    if (!dead && (kept || now - since < LOCK_STALE_MS))
      return `${owner ? `pid ${owner.pid}` : "no owner record"}, ${Math.max(0, Math.round((now - since) / 1000))} s old`;
    // Move the stale lock aside under a unique name, then check it is the one judged stale: another writer may have
    // taken it over and locked again in between. Rename keeps the inode, so the inode and record identify it.
    const moved = `${lock}.${process.pid}.${randomUUID()}.stale`;
    try {
      renameSync(lock, moved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const taken = inspect(moved);
    if (taken?.ino === seen.ino && taken.raw === seen.raw) {
      rmSync(moved, { recursive: true, force: true });
      continue;
    }
    // That was a live writer's lock: put it back without replacing a newer one. If a third writer took the path
    // meanwhile, the moved lock is kept where it is, never deleted, and the takeover fails.
    try {
      linkSync(moved, lock);
    } catch (error) {
      throw fail(`a live writer's lock could not be put back; it is kept at ${moved}: ${(error as Error).message}`);
    }
    rmSync(moved, { recursive: true, force: true });
  }
  return "the lock changed hands while taking it over; retry";
};
