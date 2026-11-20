import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/cli-args.ts";
import { runLock } from "../src/cli-lock.ts";
import { status } from "../src/cli-up.ts";
import type { Child, RunEnv } from "../src/lock.ts";
import { lockLine } from "../src/lock-list.ts";
import { lockDir, stamp } from "../src/lock-owner.ts";
import { Refusal } from "../src/refusal.ts";
import { setup } from "./harness-setup.ts";
import { lockWorld } from "./lock-setup.ts";

// The shared state dir (DORI_HOME/state, also OMP's default runtime state) holds other tools' locks.
beforeEach(() => void spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => mock.restore());

function fakeRun(root: string, now: () => number) {
  const ran: (readonly string[])[] = [];
  const env: RunEnv = {
    ...lockWorld().env(1),
    root,
    now,
    spawn: (cmd): Child => {
      ran.push(cmd);
      return { pid: process.pid, start: () => {}, exited: Promise.resolve(0), kill: () => {} };
    },
    onSignal: () => () => {},
  };
  return { env, ran };
}

const lines = (run: () => void): string[] => {
  const out: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  run();
  log.mockRestore();
  return out;
};

test("status lists only lock directories: other tools' *.lock files and dot-named directories are not locks", () => {
  const { d } = setup();
  const state = join(d.store.root, "state");
  mkdirSync(state, { recursive: true });
  for (const f of ["aside-slot-1.lock", "notice_queue.lock", "model_sync_profile.json.lock"])
    writeFileSync(join(state, f), "");
  mkdirSync(join(state, ".hidden.lock"));
  mkdirSync(lockDir(d.store.root, "demo"));
  writeFileSync(join(lockDir(d.store.root, "demo"), "owner"), `holder ${stamp(d.now())} pid=${process.pid}\n`);

  const out = lines(() => status(d));

  expect(out.filter((l) => l.startsWith("lock "))).toEqual([`lock demo: held by holder 0m (pid ${process.pid})`]);
});

test("a lock name taken by a file is refused, not run and not removed", async () => {
  const { d } = setup();
  mkdirSync(join(d.store.root, "state"), { recursive: true });
  const file = join(d.store.root, "state", "notice_queue.lock");
  writeFileSync(file, "someone else's\n");
  const { env, ran } = fakeRun(d.store.root, d.now);

  await expect(runLock(d, parse(["lock", "notice_queue", "--lane", "k-lane", "--", "true"]), env)).rejects.toThrow(
    "state/notice_queue.lock is not a lock directory",
  );
  expect(lockLine(env, "notice_queue")).toBe("lock notice_queue: free");
  expect(ran).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("someone else's\n");
  expect(readdirSync(join(d.store.root, "state", "locks", "notice_queue"))).toEqual([]);
});

test("--lane is a lane key: spaces, line breaks, owner fields and paths are refused before queueing", async () => {
  const { d } = setup();
  const { env, ran } = fakeRun(d.store.root, d.now);
  for (const lane of ["x cmd=1", "a\nb", "../foo", "Upper"])
    await expect(runLock(d, parse(["lock", "demo", "--lane", lane, "--", "true"]), env)).rejects.toThrow("lane key");
  expect(ran).toEqual([]);
});

test.each(["lead", "duty", "duty-loop", "hourly-loop"])(
  "reserved --lane %s is refused before queueing",
  async (lane) => {
    const { d } = setup();
    const { env, ran } = fakeRun(d.store.root, d.now);

    await expect(runLock(d, parse(["lock", "demo", "--lane", lane, "--", "true"]), env)).rejects.toBeInstanceOf(
      Refusal,
    );

    expect(ran).toEqual([]);
    expect(existsSync(lockDir(d.store.root, "demo"))).toBe(false);
    expect(existsSync(join(d.store.root, "state", "locks", "demo"))).toBe(false);
  },
);

test("a valid unrecorded --lane still runs without creating a lane record", async () => {
  const { d } = setup();
  const { env, ran } = fakeRun(d.store.root, d.now);
  expect(d.store.lane("no-record")).toBeUndefined();

  expect(await runLock(d, parse(["lock", "demo", "--lane", "no-record", "--", "true"]), env)).toBe(0);

  expect(ran).toEqual([["true"]]);
  expect(d.store.lane("no-record")).toBeUndefined();
  expect(existsSync(lockDir(d.store.root, "demo"))).toBe(false);
  expect(readdirSync(join(d.store.root, "state", "locks", "demo"))).toEqual([]);
});

test("status removes only a dead waiter's ticket: other JSON under state/locks is left alone", () => {
  const { d } = setup();
  const dead = Bun.spawnSync(["true"]).pid;
  const dirs = [join(d.store.root, "state", "locks", ".cache"), join(d.store.root, "state", "locks", "demo")];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "note.json"), '{"note":"not a ticket"}');
    writeFileSync(join(dir, "pid-text.json"), `{"lane":"x","pid":"${dead}","at":1,"priority":5,"seq":1}`);
  }
  writeFileSync(join(dirs[1]!, "1-gone.json"), JSON.stringify({ lane: "gone", pid: dead, at: 1, priority: 5, seq: 1 }));

  expect(lines(() => status(d)).filter((l) => l.startsWith("lock "))).toEqual([]);

  expect(readdirSync(dirs[0]!).sort()).toEqual(["note.json", "pid-text.json"]);
  expect(readdirSync(dirs[1]!).sort()).toEqual(["note.json", "pid-text.json"]);
});
