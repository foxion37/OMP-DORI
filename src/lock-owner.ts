import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ClaimEnv, underClaim } from "./lock-claim.ts";
import { Refusal } from "./refusal.ts";

/**
 * The lock directory `<root>/state/<name>.lock`, shared with shell waiters that only `mkdir` it and write
 * `<lane> <YYYY-MM-DD HH:MM:SS> pid=<pid>` (local time) into its `owner` file. `dori harness lock` adds ` cmd=<pid>`,
 * the command it runs, before that command starts. A shell waiter clears a lock by its own script's rules, not under
 * the claim below, so what this file guarantees about clearing holds between `dori harness lock` waiters.
 */
export type OwnerEnv = ClaimEnv & { root: string };
export type Holder = { owner: string; lane: string; pid?: number; since: number };

/** A lock directory with no owner line is a holder that died between mkdir and writing it, once it is this old. */
export const OWNERLESS_MS = 60_000;

export const lockDir = (root: string, name: string): string => join(root, "state", `${name}.lock`);

const pad = (n: number): string => String(n).padStart(2, "0");
/** The shell lock's owner time: local, second precision. */
export function stamp(ms: number): string {
  const t = new Date(ms);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

const readOr = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/**
 * Whether `path` exists and is not a directory. `DORI_HOME/state` is shared with other tools (it is OMP's default
 * runtime state dir) whose lock files also end in `.lock`; those are not locks of this kind, and are never touched.
 */
function notDirectory(path: string): boolean {
  try {
    return !lstatSync(path).isDirectory();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * The current holder from the owner line; a lock without one (yet) reports its directory time. A `<name>.lock` that
 * is not a directory (notDirectory) has none.
 */
export function holder(root: string, name: string): Holder | undefined {
  const dir = lockDir(root, name);
  if (notDirectory(dir)) return undefined;
  let mtime: number;
  try {
    mtime = statSync(dir).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const owner = readOr(join(dir, "owner"));
  if (owner === undefined) return { owner: "", lane: "?", since: mtime };
  const m = /^(\S+) (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/.exec(owner);
  const since = m ? new Date(`${m[2]}T${m[3]}`).getTime() : mtime;
  const pid = / pid=(\d+)/.exec(owner)?.[1];
  return { owner, lane: m?.[1] ?? owner.split(" ")[0]!, ...(pid !== undefined ? { pid: Number(pid) } : {}), since };
}

/**
 * Why the lock in place is left behind (and may be cleared), or undefined while its holder may still be running: the
 * holder's pid or its command's still runs, or it is an ownerless lock younger than OWNERLESS_MS.
 */
function staleWhy(env: OwnerEnv, dir: string, owner: string | undefined): string | undefined {
  if (owner === undefined) {
    const age = env.now() - statSync(dir).mtimeMs;
    return age > OWNERLESS_MS ? `ownerless lock older than ${OWNERLESS_MS / 1000}s` : undefined;
  }
  const pids = [...owner.matchAll(/(?:^|\s)(?:pid|cmd)=(\d+)/g)].map((m) => Number(m[1]));
  if (pids.length === 0 || pids.some((p) => env.alive(p))) return undefined;
  return `stale lock from dead pid ${pids.join(", ")} (${owner})`;
}

/**
 * Removes the lock judged left behind as `seen`. Every taker that judged that same owner line needs one claim
 * (underClaim), and the claim holder removes the directory only while it still reads as `seen` and is still left
 * behind: a taker that paused after reading it can never remove a lock another process took meanwhile. The directory
 * is never moved, so a shell waiter's `mkdir` keeps failing for as long as anyone holds it.
 */
function clear(env: OwnerEnv, dir: string, seen: string | undefined): void {
  underClaim(env, dir, seen ?? "", OWNERLESS_MS, () => {
    let now: string | undefined;
    try {
      now = readOr(join(dir, "owner"));
      if (now !== seen || staleWhy(env, dir, now) === undefined) return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

const writeOwner = (dir: string, owner: string): void => {
  writeFileSync(join(dir, "owner.tmp"), `${owner}\n`);
  renameSync(join(dir, "owner.tmp"), join(dir, "owner"));
};

/** One attempt at the lock directory: the owner line written, or why it is busy. Another tool's file there is refused. */
export function tryTake(
  env: OwnerEnv,
  name: string,
  lane: string,
  log: (line: string) => void,
): { owner: string } | { busy: string } {
  const dir = lockDir(env.root, name);
  for (let i = 0; i < 3; i++) {
    try {
      mkdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (notDirectory(dir))
        throw new Refusal(`state/${name}.lock is not a lock directory (another tool's lock?); use another lock name`);
      const seen = readOr(join(dir, "owner"));
      let why: string | undefined;
      try {
        why = staleWhy(env, dir, seen);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (why === undefined) return { busy: seen ?? "a holder still writing its owner line" };
      log(`LOCK ${name}: ${why}; clearing`);
      clear(env, dir, seen);
      continue;
    }
    const owner = `${lane} ${stamp(env.now())} pid=${env.pid}`;
    writeOwner(dir, owner);
    return { owner };
  }
  return { busy: "contended" };
}

/**
 * Names the holder's command on its owner line, so for other `dori harness lock` waiters the lock stays held while it
 * runs; the new owner line. A shell waiter keeps it held only if its script reads `cmd=` too.
 */
export function nameCommand(root: string, name: string, owner: string, pid: number): string {
  const named = `${owner} cmd=${pid}`;
  writeOwner(lockDir(root, name), named);
  return named;
}

/** Removes the lock only while it is still this owner's. */
export function release(root: string, name: string, owner: string): void {
  const dir = lockDir(root, name);
  if (readOr(join(dir, "owner")) === owner) rmSync(dir, { recursive: true, force: true });
}
