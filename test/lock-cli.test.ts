import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, USAGE } from "../src/cli-args.ts";
import { main } from "../src/cli.ts";
import { runLock } from "../src/cli-lock.ts";
import { status } from "../src/cli-up.ts";
import { startLane } from "../src/lanes.ts";
import type { Child, RunEnv } from "../src/lock.ts";
import { lockLine } from "../src/lock-list.ts";
import { enqueue, tickets } from "../src/lock-queue.ts";
import { lockDir, stamp } from "../src/lock-owner.ts";
import { loopTick } from "../src/loop.ts";
import { setup } from "./harness-setup.ts";
import { setup as loopSetup } from "./loop-setup.ts";
import { lockWorld } from "./lock-setup.ts";

// runLock logs its LOCK lines to stderr; keep the test output clean.
beforeEach(() => void spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => mock.restore());

/** console.log lines while `run` runs. */
async function logged(run: () => unknown): Promise<string[]> {
  const out: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  await run();
  log.mockRestore();
  return out;
}

/** A run env on d's home and clock whose command is recorded and exits 0 at once; this process's pid is alive. */
function fakeRun(root: string, now: () => number) {
  const w = lockWorld();
  w.live.add(process.pid);
  const ran: (readonly string[])[] = [];
  const env: RunEnv = {
    ...w.env(1),
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

describe("the command line", () => {
  test("everything after a bare -- is the command, verbatim; a value flag still takes `--` as its value", () => {
    expect(parse(["lock", "x", "--lane", "k", "--", "make", "--fast", "--", "y"])).toEqual({
      pos: ["lock", "x"],
      flags: new Map([["lane", ["k"]]]),
      rest: ["make", "--fast", "--", "y"],
    });
    expect(parse(["send", "lead", "--text", "--"]).flags.get("text")).toEqual(["--"]);
  });

  test("USAGE names lock, lock --list, start --priority and priority", () => {
    expect(USAGE).toContain("dori harness lock <name> --lane K [--priority 1-9] -- CMD [ARG ...]");
    expect(USAGE).toContain("dori harness lock <name> --list");
    expect(USAGE).toContain("[--priority 1-9]");
    expect(USAGE).toContain("dori harness priority <key> <1-9>");
  });

  test("start --priority and priority set the lane's priority; out of 1-9 is refused", async () => {
    const { d, brief } = setup();
    await logged(() => main(["start", "a-lane", "--brief", brief, "--priority", "2", "--workspace", "w1"], d));
    expect(d.store.lane("a-lane")?.priority).toBe(2);
    expect(await logged(() => main(["priority", "a-lane", "7"], d))).toEqual(["PRIORITY a-lane p7"]);
    expect(d.store.lane("a-lane")?.priority).toBe(7);
    await expect(main(["priority", "a-lane", "0"], d)).rejects.toThrow("--priority must be 1 (first) to 9 (last)");
    await expect(main(["start", "b-lane", "--brief", brief, "--priority", "x"], d)).rejects.toThrow("--priority");
    expect(d.store.lane("b-lane")).toBeUndefined();
  });

  test("the hourly loop opens a backlog item's lane with the item's priority", async () => {
    const { d, add } = loopSetup();
    add("urgent", { priority: 1 });
    await loopTick(d, { force: true });
    expect(d.store.lane("urgent")?.priority).toBe(1);
  });
});

describe("a lock's turn and line", () => {
  test("the turn's priority is --priority, else the lane record's, else 5", async () => {
    const { d, brief } = setup();
    await startLane(d, "p-two", brief, { group: "w1", priority: 2 });
    const seen: number[] = [];
    for (const argv of [
      ["lock", "demo", "--lane", "p-two", "--priority", "8", "--", "true"],
      ["lock", "demo", "--lane", "p-two", "--", "true"],
      ["lock", "demo", "--lane", "no-record", "--", "true"],
    ]) {
      const { env, ran } = fakeRun(d.store.root, d.now);
      // Another lane holds the lock, so the turn waits in line: its ticket shows the priority, then the holder leaves.
      mkdirSync(lockDir(d.store.root, "demo"), { recursive: true });
      writeFileSync(join(lockDir(d.store.root, "demo"), "owner"), `other ${stamp(d.now())} pid=${process.pid}\n`);
      env.sleep = async () => {
        seen.push(...tickets(env, "demo").map((t) => t.priority));
        rmSync(lockDir(d.store.root, "demo"), { recursive: true });
      };
      expect(await runLock(d, parse(argv), env)).toBe(0);
      expect(ran).toEqual([["true"]]);
    }
    expect(seen).toEqual([8, 2, 5]);
  });

  test("a lock with no command after -- is refused", async () => {
    const { d } = setup();
    const { env, ran } = fakeRun(d.store.root, d.now);
    await expect(runLock(d, parse(["lock", "demo", "--lane", "k-lane"]), env)).rejects.toThrow("lock needs a command");
    expect(ran).toEqual([]);
  });

  test("--list and status show the holder and the queue in turn order on one line", async () => {
    const { w, d } = setup();
    // Live waiters as main() and status() see them: this process's pid, on d's clock.
    const env = { ...lockWorld().env(process.pid), root: d.store.root, now: d.now, alive: () => true };
    mkdirSync(lockDir(d.store.root, "demo"), { recursive: true });
    const owner = `holder ${stamp(w.clock - 12 * 60_000)} pid=${process.pid}\n`;
    writeFileSync(join(lockDir(d.store.root, "demo"), "owner"), owner);
    w.clock -= 9 * 60_000;
    enqueue(env, "demo", "slow", 5);
    w.clock += 6 * 60_000;
    enqueue(env, "demo", "fast", 1);
    w.clock += 3 * 60_000;
    const line = `lock demo: held by holder 12m (pid ${process.pid}) | queue: 1) fast p1 3m 2) slow p5 9m`;
    expect(lockLine(env, "demo")).toBe(line);
    expect(await logged(() => main(["lock", "demo", "--list"], d))).toEqual([line]);
    expect((await logged(() => status(d))).at(-1)).toBe(line);
  });

  test("waiters that do not fit in 120 columns are counted", () => {
    const lw = lockWorld();
    const env = { ...lw.env(1), alive: () => true };
    for (let i = 0; i < 12; i++) {
      lw.clock += 1;
      enqueue(env, "demo", `a-rather-long-lane-key-${i}`, 5);
    }
    const line = lockLine(env, "demo");
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
    expect(line).toMatch(/^lock demo: free \| queue: 1\) a-rather-long-lane-key-0 p5 0m .* \+\d+ more$/);
  });
});
