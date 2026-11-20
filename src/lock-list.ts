import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { ageText, fitEnd, oneName, WIDTH } from "./fit.ts";
import { holder } from "./lock-owner.ts";
import { type LockEnv, lockName, tickets } from "./lock-queue.ts";

const LOCK_SUFFIX = ".lock";

/**
 * The names of the locks held or waited for under `root`: a lock directory or a queue with tickets. A shell `mkdir`
 * lock of a valid name is one of them too, as it is the same lock. `state/` is shared with other tools (it is OMP's
 * default runtime state dir): their `*.lock` files and entries whose names are not lock names are not shown.
 */
function lockNames(env: LockEnv): string[] {
  const state = join(env.root, "state");
  const dirs = (dir: string): string[] => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  };
  const held = dirs(state)
    .filter((f) => f.endsWith(LOCK_SUFFIX))
    .map((f) => f.slice(0, -LOCK_SUFFIX.length));
  // Only a lock name's queue is read: reading one removes its dead waiters' tickets.
  const queued = dirs(join(state, "locks")).filter((n) => lockName(n) && tickets(env, n).length > 0);
  return [...new Set([...held, ...queued])].filter(lockName).sort();
}

/**
 * `lock <name>: held by <lane> 12m (pid N) | queue: 1) <lane> p1 3m 2) <lane> p5 9m +N more`, within WIDTH columns:
 * waiters that do not fit are counted in `+N more`, and the holder's part is cut last.
 */
export function lockLine(env: LockEnv, name: string): string {
  const now = env.now();
  const h = holder(env.root, name);
  const head = `lock ${name}: ${
    h === undefined
      ? "free"
      : `held by ${oneName(h.lane)} ${ageText(now - h.since)}${h.pid !== undefined ? ` (pid ${h.pid})` : ""}`
  }`;
  const queue = tickets(env, name).map((t, i) => `${i + 1}) ${oneName(t.lane)} p${t.priority} ${ageText(now - t.at)}`);
  if (queue.length === 0) return fitEnd(head, WIDTH);
  for (let shown = queue.length; shown >= 0; shown--) {
    const parts = [...queue.slice(0, shown), ...(shown < queue.length ? [`+${queue.length - shown} more`] : [])];
    const line = `${head} | queue: ${parts.join(" ")}`;
    if (Bun.stringWidth(line) <= WIDTH) return line;
  }
  return fitEnd(`${head} | queue: +${queue.length} more`, WIDTH);
}

/** One line per lock under `root`, for `status`; none when no lock is held or waited for. */
export const lockLines = (env: LockEnv): string[] => lockNames(env).map((n) => lockLine(env, n));
