import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { type LedgerThread, ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { type TestState, withState } from "./fakes.ts";

const A = { teamId: "T01", userId: "U01" };
const B = { teamId: "T02", userId: "U01" };
const thread: LedgerThread = { channel: "C01", rootTs: "1.000100", seenTs: "2.000100" };
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const file = () => join(state.dir, "threads.json");

test("another account cannot advance an equal channel and root, even with a newer timestamp", async () => {
  const ledger = new ThreadLedger(file());
  await ledger.record(A, "C01", "1.000100", "2.000100");
  const original = fs.readFileSync(file(), "utf8");
  await ledger.markSeen(B, [{ channel: "C01", rootTs: "1.000100", ts: "9.000100" }]);
  expect(fs.readFileSync(file(), "utf8")).toBe(original);
  expect(await ledger.list(A)).toEqual([thread]);
});

test("invalid scopes, duplicate qualified routes and unversioned rows never reset or rewrite the ledger", async () => {
  for (const doc of [
    { version: 2, threads: [{ ...thread, scope: {} }] },
    {
      version: 2,
      threads: [
        { ...thread, scope: A },
        { ...thread, scope: A },
      ],
    },
    { version: 3, threads: [] },
    [thread],
  ]) {
    const original = JSON.stringify(doc);
    fs.writeFileSync(file(), original);
    const ledger = new ThreadLedger(file());
    expect(() => ledger.assertReadable()).toThrow();
    await expect(ledger.list(A)).rejects.toThrow();
    await expect(ledger.record(A, "C03", "3.0", "3.0")).rejects.toThrow();
    expect(fs.readFileSync(file(), "utf8")).toBe(original);
  }
});
