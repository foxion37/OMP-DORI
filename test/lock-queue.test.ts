import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holder, lockDir, release, stamp, tryTake } from "../src/lock-owner.ts";
import { checkName, enqueue, queueDir, take, tickets } from "../src/lock-queue.ts";
import { lockWorld } from "./lock-setup.ts";

const NAME = "demo";
const never = new AbortController().signal;

/** A lock taken by a shell waiter: the directory and its owner line, as the shell script writes them. */
function shellLock(root: string, owner: string): void {
  mkdirSync(lockDir(root, NAME), { recursive: true });
  writeFileSync(join(lockDir(root, NAME), "owner"), `${owner}\n`);
}

describe("waiters take the lock by priority, then in arrival order", () => {
  test("two p5 waiters first, p1 arrives later: p1 goes next, then the p5 waiters in arrival order", async () => {
    const w = lockWorld();
    const first = (await take(w.env(1), NAME, "holder", 5, never))!;
    const order: string[] = [];
    const waiter = (pid: number, lane: string, priority: number) => {
      w.clock += 1;
      return take(w.env(pid), NAME, lane, priority, never).then((owner) => {
        order.push(lane);
        return owner!;
      });
    };
    const b = waiter(2, "b", 5);
    const c = waiter(3, "c", 5);
    const d = waiter(4, "d", 1);
    expect(tickets(w.env(9), NAME).map((t) => t.lane)).toEqual(["d", "b", "c"]);
    await w.tick();
    expect(order).toEqual([]);
    release(w.root, NAME, first);
    await w.tick();
    expect(order).toEqual(["d"]);
    expect(holder(w.root, NAME)?.lane).toBe("d");
    release(w.root, NAME, await d);
    await w.tick();
    release(w.root, NAME, await b);
    await w.tick();
    release(w.root, NAME, await c);
    expect(order).toEqual(["d", "b", "c"]);
    expect(existsSync(lockDir(w.root, NAME))).toBe(false);
    expect(readdirSync(queueDir(w.root, NAME))).toEqual([]);
  });

  test("a shell waiter's lock is waited on while its pid lives, and the owner line reads back", async () => {
    const w = lockWorld();
    w.live.add(77);
    const since = new Date(2026, 10, 14, 9, 30, 5).getTime();
    shellLock(w.root, `shell-job ${stamp(since)} pid=77`);
    const lines: string[] = [];
    const got = take(w.env(1), NAME, "mine", 5, never, (l) => lines.push(l));
    await w.tick();
    expect(lines).toEqual([`LOCK ${NAME}: waiting (p5), held by shell-job ${stamp(since)} pid=77`]);
    expect(holder(w.root, NAME)).toEqual({
      owner: `shell-job ${stamp(since)} pid=77`,
      lane: "shell-job",
      pid: 77,
      since,
    });
    w.live.delete(77);
    await w.tick();
    expect((await got)?.startsWith("mine ")).toBe(true);
    expect(lines.at(-1)).toBe(`LOCK ${NAME}: stale lock from dead pid 77 (shell-job ${stamp(since)} pid=77); clearing`);
  });
});

describe("what is left behind is cleared, and nothing else", () => {
  test("a ticket of a dead waiter is removed; a live one stays", () => {
    const w = lockWorld();
    enqueue(w.env(1), NAME, "live", 5);
    enqueue(w.env(2), NAME, "dead", 1);
    w.live.delete(2);
    expect(tickets(w.env(9), NAME).map((t) => t.lane)).toEqual(["live"]);
    expect(readdirSync(queueDir(w.root, NAME))).toHaveLength(1);
  });

  test("a guard held by a live waiter turns the next away; one left by a dead waiter is taken over", () => {
    const w = lockWorld();
    mkdirSync(queueDir(w.root, NAME), { recursive: true });
    writeFileSync(join(queueDir(w.root, NAME), ".guard"), "pid=7 x");
    w.live.add(7);
    expect(enqueue(w.env(1), NAME, "mine", 5)).toBeUndefined();
    w.live.delete(7);
    expect(enqueue(w.env(1), NAME, "mine", 5)?.lane).toBe("mine");
    expect(readdirSync(queueDir(w.root, NAME)).filter((f) => !f.endsWith(".json"))).toEqual([]);
  });

  test("a lock with no owner line is busy until it is older than a minute, then cleared", () => {
    const w = lockWorld();
    mkdirSync(lockDir(w.root, NAME), { recursive: true });
    utimesSync(lockDir(w.root, NAME), 1_000, 1_000);
    const made = statSync(lockDir(w.root, NAME)).mtimeMs;
    const env = w.env(1, { now: () => w.clock });
    w.clock = made + 30_000;
    expect(tryTake(env, NAME, "mine", () => {})).toEqual({ busy: "a holder still writing its owner line" });
    w.clock = made + 61_000;
    const got = tryTake(env, NAME, "mine", () => {});
    expect("owner" in got && got.owner.startsWith("mine ")).toBe(true);
  });

  test("release leaves a lock that is no longer this owner's", () => {
    const w = lockWorld();
    w.live.add(5);
    shellLock(w.root, "other 2026-11-14 09:00:00 pid=5");
    release(w.root, NAME, "mine 2026-11-14 08:00:00 pid=1");
    expect(holder(w.root, NAME)?.lane).toBe("other");
  });

  test("a wait stopped before its turn withdraws its ticket and takes nothing", async () => {
    const w = lockWorld();
    w.live.add(5);
    shellLock(w.root, "other 2026-11-14 09:00:00 pid=5");
    const stop = new AbortController();
    const lines: string[] = [];
    const got = take(w.env(1), NAME, "mine", 3, stop.signal, (l) => lines.push(l));
    expect(tickets(w.env(9), NAME).map((t) => t.lane)).toEqual(["mine"]);
    stop.abort();
    expect(await got).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(readdirSync(queueDir(w.root, NAME))).toEqual([]);
    expect(holder(w.root, NAME)?.lane).toBe("other");
  });

  test("a lock name outside letters, digits, dot, dash and underscore is refused", () => {
    expect(checkName("account-1")).toBe("account-1");
    for (const bad of ["", "../x", "a/b", "-x", "a b"]) expect(() => checkName(bad)).toThrow();
  });
});
