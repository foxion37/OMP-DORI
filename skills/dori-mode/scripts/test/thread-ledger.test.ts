import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { type TestState, withState } from "./fakes.ts";

const SCOPE = { teamId: "T_TEST", userId: "self" };

// The receiver's ledger lives as long as `dori inbound slack --loop`; each `dori send slack` writes the same file.
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const onDisk = (file: string): string[] =>
  (
    JSON.parse(readFileSync(file, "utf8")) as { threads: { channel: string; rootTs: string; seenTs: string }[] }
  ).threads.map((t) => `${t.channel}:${t.rootTs}@${t.seenTs}`);

test("a long-lived ledger sees a thread another process recorded later and never erases it", async () => {
  const file = join(state.dir, "slack-threads.json");
  await new ThreadLedger(file).record(SCOPE, "C1", "1000.000100", "1000.000100");
  const receiver = new ThreadLedger(file);
  expect((await receiver.list(SCOPE)).map((t) => t.channel)).toEqual(["C1"]);
  await new ThreadLedger(file).record(SCOPE, "C2", "2000.000100", "2000.000100");
  expect((await receiver.list(SCOPE)).map((t) => t.channel)).toEqual(["C1", "C2"]);
  await receiver.markSeen(SCOPE, [{ channel: "C1", rootTs: "1000.000100", ts: "3000.000100" }]);
  expect(onDisk(file)).toEqual(["C1:1000.000100@3000.000100", "C2:2000.000100@2000.000100"]);
});

test("a seen position only moves forward, whichever process wrote last", async () => {
  const file = join(state.dir, "slack-threads.json");
  const a = new ThreadLedger(file);
  await a.record(SCOPE, "C1", "1000.000100", "1000.000100");
  await new ThreadLedger(file).markSeen(SCOPE, [{ channel: "C1", rootTs: "1000.000100", ts: "5000.000100" }]);
  await a.markSeen(SCOPE, [{ channel: "C1", rootTs: "1000.000100", ts: "3000.000100" }]);
  await a.record(SCOPE, "C1", "1000.000100", "4000.000100");
  expect(onDisk(file)).toEqual(["C1:1000.000100@5000.000100"]);
});

test("a writer waits while another process holds the ledger lock, then merges what that process wrote", async () => {
  const file = join(state.dir, "slack-threads.json");
  const lock = `${file}.lock`;
  await new ThreadLedger(file).record(SCOPE, "C1", "1000.000100", "1000.000100");
  // A live writer on this host: this process stands in for it.
  const owner = { pid: process.pid, host: hostname(), at: new Date().toISOString(), nonce: "other-writer" };
  writeFileSync(lock, JSON.stringify(owner));
  const seenWhileLocked: string[][] = [];
  const ledger = new ThreadLedger(file, async () => {
    seenWhileLocked.push(onDisk(file));
    // The other writer finishes its update and releases its lock.
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        threads: [
          { scope: SCOPE, channel: "C1", rootTs: "1000.000100", seenTs: "1000.000100" },
          { scope: SCOPE, channel: "C3", rootTs: "3000.000100", seenTs: "3000.000100" },
        ],
      }),
    );
    rmSync(lock);
  });
  await ledger.record(SCOPE, "C2", "2000.000100", "2000.000100");
  expect(seenWhileLocked).toEqual([["C1:1000.000100@1000.000100"]]);
  expect(onDisk(file)).toEqual([
    "C1:1000.000100@1000.000100",
    "C3:3000.000100@3000.000100",
    "C2:2000.000100@2000.000100",
  ]);
  expect(existsSync(lock)).toBe(false);
});

test("a lock left by a writer that stopped long ago is taken over", async () => {
  const file = join(state.dir, "slack-threads.json");
  const old = { pid: process.pid, host: hostname(), at: new Date(Date.now() - 10 * 60_000).toISOString(), nonce: "x" };
  writeFileSync(`${file}.lock`, JSON.stringify(old));
  const ledger = new ThreadLedger(file, async () => {
    throw new Error("a stale lock must not be waited for");
  });
  await ledger.record(SCOPE, "C1", "1000.000100", "1000.000100");
  expect(onDisk(file)).toEqual(["C1:1000.000100@1000.000100"]);
  expect(existsSync(`${file}.lock`)).toBe(false);
});

test("writers in separate processes never lose each other's threads", async () => {
  const file = join(state.dir, "slack-threads.json");
  const source = join(import.meta.dir, "../src/messenger/thread-ledger.ts");
  const script = `const { ThreadLedger } = await import(${JSON.stringify(source)});
const l = new ThreadLedger(${JSON.stringify(file)});
const SCOPE = ${JSON.stringify(SCOPE)};
for (let i = 0; i < 15; i++) await l.record(SCOPE, process.argv.at(-1), \`\${1000 + i}.000100\`, \`\${1000 + i}.000100\`);`;
  const writers = ["C1", "C2", "C3"].map((channel) =>
    Bun.spawn([process.execPath, "-e", script, channel], { stdout: "ignore", stderr: "pipe" }),
  );
  const codes = await Promise.all(writers.map((w) => w.exited));
  expect(codes).toEqual([0, 0, 0]);
  expect(onDisk(file).length).toBe(45);
});
