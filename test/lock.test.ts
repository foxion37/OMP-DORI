import { describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Child, type RunEnv, runLocked } from "../src/lock.ts";
import { queueDir } from "../src/lock-queue.ts";
import { holder, lockDir } from "../src/lock-owner.ts";
import { lockWorld } from "./lock-setup.ts";

const NAME = "demo";

/** A run environment whose command is a fake child: `finish(code)` ends it; signals sent to it are recorded. */
function runWorld() {
  const w = lockWorld();
  const sent: string[] = [];
  const spawned: (readonly string[])[] = [];
  let signal: ((s: "SIGTERM" | "SIGINT", foreground: boolean) => void) | undefined;
  const { promise: exited, resolve: finish } = Promise.withResolvers<number>();
  const env: RunEnv = {
    ...w.env(1),
    spawn: (cmd): Child => {
      spawned.push(cmd);
      return { pid: 4242, start: () => {}, exited, kill: (s) => sent.push(s) };
    },
    onSignal: (handler) => {
      signal = handler;
      return () => {
        signal = undefined;
      };
    },
  };
  return {
    w,
    env,
    sent,
    spawned,
    finish,
    signal: (s: "SIGTERM" | "SIGINT", foreground = false) => signal?.(s, foreground),
    hooked: () => !!signal,
  };
}

const leftNothing = (root: string) => {
  expect(existsSync(lockDir(root, NAME))).toBe(false);
  expect(existsSync(queueDir(root, NAME)) ? readdirSync(queueDir(root, NAME)) : []).toEqual([]);
};

describe("runLocked", () => {
  test("runs the command holding the lock and passes its exit code through", async () => {
    const r = runWorld();
    const run = runLocked(r.env, NAME, "mine", 5, ["make", "it"], () => {});
    await r.w.turn();
    expect(r.spawned).toEqual([["make", "it"]]);
    expect(holder(r.w.root, NAME)?.lane).toBe("mine");
    r.finish(3);
    expect(await run).toBe(3);
    leftNothing(r.w.root);
    expect(r.hooked()).toBe(false);
  });

  test("a signal while the command runs is passed to it; the lock is released once it exits", async () => {
    const r = runWorld();
    const run = runLocked(r.env, NAME, "mine", 5, ["sleep", "9"], () => {});
    await r.w.turn();
    r.signal("SIGTERM");
    expect(r.sent).toEqual(["SIGTERM"]);
    expect(holder(r.w.root, NAME)?.lane).toBe("mine");
    r.finish(143);
    expect(await run).toBe(143);
    leftNothing(r.w.root);
  });

  test("a Ctrl-C at the terminal reaches the command once: the terminal sends it to the command too", async () => {
    const r = runWorld();
    const run = runLocked(r.env, NAME, "mine", 5, ["sleep", "9"], () => {});
    await r.w.turn();
    r.signal("SIGINT", true);
    expect(r.sent).toEqual([]);
    r.signal("SIGINT", false);
    expect(r.sent).toEqual(["SIGINT"]);
    r.finish(130);
    expect(await run).toBe(130);
    leftNothing(r.w.root);
  });

  test("a signal while waiting withdraws the ticket and runs nothing: 128 + the signal", async () => {
    const r = runWorld();
    r.w.live.add(5);
    mkdirSync(lockDir(r.w.root, NAME), { recursive: true });
    writeFileSync(join(lockDir(r.w.root, NAME), "owner"), "other 2026-11-14 09:00:00 pid=5\n");
    const lines: string[] = [];
    const run = runLocked(r.env, NAME, "mine", 5, ["make"], (l) => lines.push(l));
    await r.w.turn();
    expect(lines).toEqual([`LOCK ${NAME}: waiting (p5), held by other 2026-11-14 09:00:00 pid=5`]);
    r.signal("SIGINT");
    expect(await run).toBe(130);
    expect(r.spawned).toEqual([]);
    expect(readdirSync(queueDir(r.w.root, NAME))).toEqual([]);
    expect(holder(r.w.root, NAME)?.lane).toBe("other");
  });

  test("a signal that comes as the lock is taken, before the command starts, runs nothing: 128 + the signal", async () => {
    const r = runWorld();
    // The signal arrives just as the owner line is put in place (the last step of the take).
    let sent = false;
    const rename = fs.renameSync;
    spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      rename(from, to);
      if (!sent && String(to) === join(lockDir(r.w.root, NAME), "owner")) {
        sent = true;
        r.signal("SIGTERM");
      }
    }) as never);
    const run = runLocked(r.env, NAME, "mine", 5, ["make"], () => {});
    expect(await run).toBe(143);
    mock.restore();
    expect(sent).toBe(true);
    expect(r.spawned).toEqual([]);
    leftNothing(r.w.root);
  });

  test("no command after -- or a bad name is refused before anything is queued", async () => {
    const r = runWorld();
    await expect(runLocked(r.env, NAME, "mine", 5, [], () => {})).rejects.toThrow("lock needs a command after --");
    await expect(runLocked(r.env, "../x", "mine", 5, ["true"], () => {})).rejects.toThrow();
    expect(existsSync(queueDir(r.w.root, NAME))).toBe(false);
  });
});
