import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import { lockEnv } from "../src/lock.ts";
import { holder, lockDir, tryTake } from "../src/lock-owner.ts";
import { enqueue, take, tickets } from "../src/lock-queue.ts";
import { lockWorld } from "./lock-setup.ts";

const NAME = "demo";
const never = new AbortController().signal;
const REAL_READ = fs.readFileSync;
const REAL_RENAME = fs.renameSync;
const REAL_MKDIR = fs.mkdirSync;
type Attempt = { owner: string } | { busy: string };

afterEach(() => mock.restore());

/** A lock as a shell waiter writes it: the directory and its owner line. */
function shellLock(root: string, owner: string): void {
  REAL_MKDIR(lockDir(root, NAME), { recursive: true });
  fs.writeFileSync(join(lockDir(root, NAME), "owner"), `${owner}\n`);
}
const ownerOf = (root: string): string => (REAL_READ(join(lockDir(root, NAME), "owner"), "utf8") as string).trim();

// POSIX-only: a FIFO, /bin/sh and SIGKILL carry the command past its wrapper.
const posix = test.skipIf(process.platform === "win32");

test("a stale takeover paused after reading the dead owner never moves or removes a live replacement's lock", () => {
  const w = lockWorld();
  const dead = "gone 2026-11-14 09:00:00 pid=66";
  shellLock(w.root, dead);
  const shell = "shell-job 2026-11-14 09:00:01 pid=77";
  w.live.add(77);
  const owner = join(lockDir(w.root, NAME), "owner");
  // P reads the dead owner and pauses; meanwhile the stale lock is cleared and a shell waiter takes the name. From then
  // on a third waiter R tries the lock at every step P takes: it must always find the lock held.
  let paused = true;
  let inside = false;
  const tries: Attempt[] = [];
  const third = () => {
    if (inside) return;
    inside = true;
    try {
      tries.push(tryTake(w.env(3), NAME, "third", () => {}));
    } finally {
      inside = false;
    }
  };
  spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const read = (REAL_READ as (...a: unknown[]) => unknown)(file, ...rest);
    if (paused && String(file) === owner && String(read).trim() === dead) {
      paused = false;
      fs.rmSync(lockDir(w.root, NAME), { recursive: true, force: true });
      shellLock(w.root, shell);
    } else if (!paused) third();
    return read;
  }) as never);
  spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    REAL_RENAME(from, to);
    if (!paused) third();
  }) as never);

  const p = tryTake(w.env(2), NAME, "mine", () => {});
  mock.restore();
  third();

  expect(p).toEqual({ busy: shell });
  expect(tries.filter((t) => "owner" in t)).toEqual([]);
  expect(ownerOf(w.root)).toBe(shell);
});

test("a takeover whose claimer died is finished by the next waiter, and nothing is left beside the lock", () => {
  const w = lockWorld();
  const dead = "gone 2026-11-14 09:00:00 pid=66";
  shellLock(w.root, dead);
  // A claimer (pid 5) took the claim on that dead owner line and was killed before it cleared the lock.
  const digest = createHash("sha256")
    .update(basename(lockDir(w.root, NAME)))
    .update("\0")
    .update(dead)
    .digest("hex");
  fs.writeFileSync(join(w.root, "state", `.lock-claim-${digest}`), "pid=5 x");

  const got = tryTake(w.env(6), NAME, "next", () => {});

  expect("owner" in got && got.owner.startsWith("next ")).toBe(true);
  expect(fs.readdirSync(join(w.root, "state"))).toEqual([`${NAME}.lock`]);
  expect(fs.readdirSync(lockDir(w.root, NAME))).toEqual(["owner"]);
});

posix("a lock whose wrapper was killed stays held while its command still runs", async () => {
  const root = lockWorld().root;
  // The command outlives its wrapper: it prints its pid, then waits for a line on a FIFO this test writes.
  const go = join(root, "go");
  expect(Bun.spawnSync(["/usr/bin/mkfifo", go]).exitCode).toBe(0);
  const cmd = ["/bin/sh", "-c", `echo $$; read -r _ < ${go}`];
  const wrapper = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { lockEnv, runLocked } from ${JSON.stringify(join(import.meta.dir, "../src/lock.ts"))};
       await runLocked(lockEnv(${JSON.stringify(root)}), ${JSON.stringify(NAME)}, "wrapped", 5, ${JSON.stringify(cmd)}, () => {});`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const cmdPid = Number(new TextDecoder().decode((await wrapper.stdout.getReader().read()).value).trim());
  expect(Number.isInteger(cmdPid) && cmdPid > 0).toBe(true);
  wrapper.kill("SIGKILL");
  await wrapper.exited;

  const held = tryTake(lockEnv(root), NAME, "next", () => {});
  const owner = holder(root, NAME)?.owner;
  fs.writeFileSync(go, "done\n");

  expect(held).toEqual({ busy: owner! });
  expect(owner).toMatch(new RegExp(`^wrapped .* cmd=${cmdPid}$`));
});

test("a waiter at the head does not take the lock past a p1 that queued before it took it", async () => {
  const w = lockWorld();
  // p5 is alone in line and about to mkdir the free lock; a p1 tries to queue just then.
  let p1: unknown;
  spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
    if (p1 === undefined && String(path) === lockDir(w.root, NAME)) p1 = enqueue(w.env(2), NAME, "p1", 1) ?? null;
    return REAL_MKDIR(path, opts);
  }) as never);
  void take(w.env(1), NAME, "p5", 5, never);
  await w.turn();
  mock.restore();

  // Either p1 got in line first and p5 did not take the lock past it, or p1 was told to try again (it was not in line).
  expect(p1).toBeDefined();
  const queued = tickets(w.env(9), NAME).map((t) => t.lane);
  if (queued.includes("p1")) expect(holder(w.root, NAME)?.lane).not.toBe("p5");
  else expect(p1).toBeNull();
});

test("waiters of one priority arriving in the same millisecond keep their arrival order", async () => {
  const w = lockWorld();
  await take(w.env(1), NAME, "holder", 5, never);
  // Later arrivals get lower pids and the same clock, so neither breaks the tie in arrival order.
  const lanes = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (const [i, lane] of lanes.entries()) void take(w.env(90 - i), NAME, lane, 5, never);
  expect(tickets(w.env(99), NAME).map((t) => t.lane)).toEqual(lanes);
});
