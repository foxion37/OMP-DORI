import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { INBOX_LOCK_STALE_MS } from "./store-types.ts";

const readOrUndefined = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** An unreadable lock (a holder that died between create and write) is judged by the file's age. */
function lockStale(path: string, content: string, now: number): boolean {
  let lock: { pid?: unknown; host?: unknown; at?: unknown } = {};
  try {
    lock = JSON.parse(content) as typeof lock;
  } catch {
    // fall through to the file's mtime
  }
  // On this host the pid decides: a live holder keeps its lock however long a delivery takes, or a second flush
  // would deliver the same batch again. The age rule is only for locks from another host or locks that can't be read.
  if (lock.host === hostname() && typeof lock.pid === "number") return !pidAlive(lock.pid);
  const at =
    typeof lock.at === "number"
      ? lock.at
      : (() => {
          try {
            return statSync(path).mtimeMs;
          } catch {
            return now;
          }
        })();
  return now - at > INBOX_LOCK_STALE_MS;
}

/**
 * Takes the lock at `path` (created O_EXCL, holding pid, host, time and a unique nonce) and returns its release, or
 * undefined while another process holds it. A stale lock is taken over under a fixed-length sibling claim named by
 * the target basename and observed-content digest, itself taken with this function so dead claimers are recoverable.
 * Only the claim holder removes the lock, and only when it still reads as the stale snapshot the claim names: a taker
 * that paused after reading it can never remove a lock another process took over meanwhile.
 */
export function takeInboxLock(path: string, now: number): (() => void) | undefined {
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), at: now, nonce: randomUUID() });
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(path, mine, { flag: "wx" });
      return () => {
        if (readOrUndefined(path) === mine) rmSync(path, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const seen = readOrUndefined(path);
    if (seen === undefined) continue;
    if (!lockStale(path, seen, now)) return undefined;
    const digest = createHash("sha256").update(basename(path)).update("\0").update(seen).digest("hex");
    const claim = takeInboxLock(join(dirname(path), `.inbox-claim-${digest}`), now);
    if (!claim) return undefined;
    try {
      if (readOrUndefined(path) === seen) rmSync(path, { force: true });
    } finally {
      claim();
    }
  }
  return undefined;
}
