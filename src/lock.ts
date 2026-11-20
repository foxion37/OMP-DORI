import { writeSync } from "node:fs";
import { constants } from "node:os";
import { alive } from "../skills/dori-mode/scripts/src/checkpoint-lock.ts";
import { nameCommand, release } from "./lock-owner.ts";
import { procStat } from "./update/proc.ts";
import { checkName, type LockEnv, RETRY_MS, take } from "./lock-queue.ts";
import { Refusal } from "./refusal.ts";

type Signal = "SIGTERM" | "SIGINT";
/**
 * A command spawned held at a gate: `start()` lets it run. Until then its pid exists but nothing of the command has
 * run, so the lock can name that pid first. `exited` is its exit code (128 + the signal when a signal ended it).
 */
export type Child = { pid: number; start: () => void; exited: Promise<number>; kill: (signal: Signal) => void };
export type RunEnv = LockEnv & {
  spawn: (cmd: readonly string[]) => Child;
  /**
   * Calls `handler` on SIGTERM and SIGINT until the returned function is called. `foreground` is a SIGINT while this
   * process's group is the terminal's foreground group: a Ctrl-C there, which the terminal sends to the command too.
   */
  onSignal: (handler: (signal: Signal, foreground: boolean) => void) => () => void;
};

/** sh waits for `go` on fd 3, then becomes the command with the same pid; anything else exits 125, running nothing. */
const GATE = 'IFS= read -r go <&3 && [ "$go" = go ] || exit 125; exec "$@" 3<&-';

export function lockEnv(root: string): RunEnv {
  return {
    root,
    pid: process.pid,
    now: Date.now,
    alive,
    sleep: () => Bun.sleep(RETRY_MS),
    spawn: (cmd) => {
      const p = Bun.spawn(["/bin/sh", "-c", GATE, "dori-lock", ...cmd], {
        stdio: ["inherit", "inherit", "inherit", "pipe"],
      });
      return {
        pid: p.pid,
        start: () => void writeSync(p.stdio[3] as number, "go\n"),
        exited: p.exited,
        kill: (s) => p.kill(s),
      };
    },
    onSignal: (handler) => {
      const term = () => handler("SIGTERM", false);
      const int = () => {
        const { pgid, tpgid } = procStat(process.pid);
        handler("SIGINT", tpgid > 0 && tpgid === pgid);
      };
      process.on("SIGTERM", term).on("SIGINT", int);
      return () => process.off("SIGTERM", term).off("SIGINT", int);
    },
  };
}

/**
 * Waits in line for the lock `name`, runs `cmd` while holding it and returns the command's exit code. The owner line
 * names the command's pid before the command starts, so the lock stays held while it runs even if this process is
 * killed. A signal while waiting, or one that comes as the lock is taken, withdraws the ticket or releases the lock
 * and returns 128 + the signal without running anything; a signal while the command runs is passed to it (a Ctrl-C at
 * the terminal already reached it, as it shares this process's group, and is not sent again), and the lock is released
 * once it exits.
 */
export async function runLocked(
  env: RunEnv,
  name: string,
  lane: string,
  priority: number,
  cmd: readonly string[],
  log: (line: string) => void,
): Promise<number> {
  checkName(name);
  if (cmd.length === 0) throw new Refusal("lock needs a command after --");
  const stop = new AbortController();
  let child: Child | undefined;
  let signal: Signal | undefined;
  const off = env.onSignal((s, foreground) => {
    signal ??= s;
    if (!child) stop.abort();
    else if (!foreground) child.kill(s);
  });
  try {
    let owner = await take(env, name, lane, priority, stop.signal, log);
    if (owner === undefined) return 128 + constants.signals[signal ?? "SIGTERM"];
    try {
      // A signal that came after the take and before the command exists has nothing to kill: run nothing.
      if (signal !== undefined) return 128 + constants.signals[signal];
      const held = env.spawn(cmd);
      child = held;
      try {
        owner = nameCommand(env.root, name, owner, held.pid);
        held.start();
      } catch (e) {
        held.kill("SIGTERM");
        await held.exited;
        throw e;
      }
      return await held.exited;
    } finally {
      release(env.root, name, owner);
    }
  } finally {
    off();
  }
}
