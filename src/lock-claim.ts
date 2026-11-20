import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** What a file lock needs to judge its holder: this process's pid, the clock, and whether a pid still runs. */
export type ClaimEnv = { pid: number; now: () => number; alive: (pid: number) => boolean };

/** The file's text, or undefined once it is gone. */
const textOf = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/** A holder that died; a file with no pid (its creator died before writing it) once it is `ownerlessMs` old. */
function holderGone(env: ClaimEnv, path: string, seen: string, ownerlessMs: number): boolean {
  const pid = /pid=(\d+)/.exec(seen)?.[1];
  if (pid !== undefined) return !env.alive(Number(pid));
  try {
    return env.now() - statSync(path).mtimeMs > ownerlessMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Takes the file lock `path` (created O_EXCL, naming this pid) and returns its release, or undefined while a live
 * process holds it. A lock whose holder is gone is removed under its claim (underClaim), so a taker that paused after
 * reading it never removes a lock another process took meanwhile.
 */
export function takeFile(env: ClaimEnv, path: string, ownerlessMs: number): (() => void) | undefined {
  const mine = `pid=${env.pid} ${randomUUID()}`;
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(path, mine, { flag: "wx" });
      return () => {
        if (textOf(path) === mine) rmSync(path, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const seen = textOf(path);
    if (seen === undefined) continue;
    if (!holderGone(env, path, seen, ownerlessMs)) return undefined;
    const taken = underClaim(env, path, seen, ownerlessMs, () => {
      if (textOf(path) === seen) rmSync(path, { force: true });
    });
    if (!taken) return undefined;
  }
  return undefined;
}

/**
 * Runs `act` under a fixed-length sibling `.lock-claim-<sha256>` keyed by the target basename and full observed
 * snapshot, or returns false while another live process holds that claim. Directory aliases share the same claim.
 * Every process that judged the same snapshot needs the same claim, and `act` checks again that `path` reads as `seen`.
 * The claim is itself a takeFile lock, so dead claimers are taken over without growing any filename.
 */
export function underClaim(env: ClaimEnv, path: string, seen: string, ownerlessMs: number, act: () => void): boolean {
  const digest = createHash("sha256").update(basename(path)).update("\0").update(seen).digest("hex");
  const claim = takeFile(env, join(dirname(path), `.lock-claim-${digest}`), ownerlessMs);
  if (!claim) return false;
  try {
    act();
  } finally {
    claim();
  }
  return true;
}
