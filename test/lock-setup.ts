import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LockEnv } from "../src/lock-queue.ts";

/** One event-loop turn: every waiter woken by tick() runs on to its next sleep (all lock file calls are sync). */
const turn = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

/**
 * A lock home on a fake clock. Each waiter is a fake pid in `live`; sleep() parks until tick(), which advances the clock
 * by the retry interval and wakes every parked waiter once.
 */
export function lockWorld() {
  const sleepers: (() => void)[] = [];
  const w = {
    root: mkdtempSync(join(tmpdir(), "dori-lock-")),
    clock: 1_000_000,
    live: new Set<number>(),
    env: (pid: number, extra: Partial<LockEnv> = {}): LockEnv => {
      w.live.add(pid);
      return {
        root: w.root,
        pid,
        now: () => w.clock,
        alive: (p: number) => w.live.has(p),
        sleep: () => {
          const { promise, resolve } = Promise.withResolvers<void>();
          sleepers.push(resolve);
          return promise;
        },
        ...extra,
      };
    },
    tick: async (ms = 2000) => {
      w.clock += ms;
      for (const wake of sleepers.splice(0)) wake();
      await turn();
    },
    turn,
  };
  return w;
}
