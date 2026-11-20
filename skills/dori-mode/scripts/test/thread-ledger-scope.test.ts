import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { type LedgerThread, ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { type TestState, withState } from "./fakes.ts";

const A = { teamId: "T01", userId: "U01" };
const B = { teamId: "T02", userId: "U01" };
const legacy: [LedgerThread, LedgerThread] = [
  { channel: "C01", rootTs: "1.000100", seenTs: "2.000100" },
  { channel: "C02", rootTs: "3.000100", seenTs: "4.000100" },
];
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const file = () => join(state.dir, "threads.json");

test("unattributed legacy records hold reads and writes without changing any saved bytes", async () => {
  const original = JSON.stringify(legacy);
  fs.writeFileSync(file(), original);
  const ledger = new ThreadLedger(file());
  expect(() => ledger.assertScoped()).toThrow("unscoped Slack threads");
  await expect(ledger.list(A)).rejects.toThrow("unscoped Slack threads");
  await expect(ledger.record(A, "C03", "5.000100", "5.000100")).rejects.toThrow("unscoped Slack threads");
  await expect(ledger.markSeen(A, [{ channel: "C01", rootTs: "1.000100", ts: "9.000100" }])).rejects.toThrow(
    "unscoped Slack threads",
  );
  expect(fs.readFileSync(file(), "utf8")).toBe(original);
  expect(fs.existsSync(`${file()}.lock`)).toBe(false);
});

test("explicit adoption preserves every old position and its immutable account receipt", async () => {
  fs.writeFileSync(file(), JSON.stringify(legacy));
  const ledger = new ThreadLedger(file());
  const receipt = await ledger.adoptLegacy(A);
  expect(receipt.scope).toEqual(A);
  expect(receipt.count).toBe(2);
  expect(Number.isFinite(Date.parse(receipt.at))).toBe(true);
  expect(await ledger.list(A)).toEqual(legacy);
  expect(await ledger.list(B)).toEqual([]);
  expect(await ledger.adoptLegacy(A)).toEqual(receipt);
  const before = fs.readFileSync(file(), "utf8");
  await expect(ledger.adoptLegacy(B)).rejects.toThrow("already adopted by another account");
  expect(fs.readFileSync(file(), "utf8")).toBe(before);
  await ledger.record(B, "C01", "1.000100", "8.000100");
  await ledger.markSeen(A, [{ channel: "C01", rootTs: "1.000100", ts: "9.000100" }]);
  expect((await ledger.list(B)).map((t) => t.seenTs)).toEqual(["8.000100"]);
  const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
  expect(saved.version).toBe(2);
  expect(saved.adopted).toEqual(receipt);
  expect(saved.threads).toHaveLength(3);
  expect(() => {
    for (const row of saved) void row;
  }).toThrow();
});

test("an empty old array needs no attribution and the first real record starts version two", async () => {
  fs.writeFileSync(file(), "[]");
  const ledger = new ThreadLedger(file());
  expect(await ledger.list(A)).toEqual([]);
  await ledger.record(B, "C01", "1.000100", "2.000100");
  expect(await ledger.list(A)).toEqual([]);
  expect(await ledger.list(B)).toEqual([legacy[0]]);
  expect(JSON.parse(fs.readFileSync(file(), "utf8")).version).toBe(2);
});

test("competing legacy adoptions select one account without losing records", async () => {
  fs.writeFileSync(file(), JSON.stringify(legacy));
  const results = await Promise.allSettled([
    new ThreadLedger(file()).adoptLegacy(A),
    new ThreadLedger(file()).adoptLegacy(B),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const winner = results.find((r) => r.status === "fulfilled");
  if (winner?.status !== "fulfilled") throw new Error("no adoption receipt");
  const ledger = new ThreadLedger(file());
  expect(await ledger.list(winner.value.scope)).toEqual(legacy);
  expect(JSON.parse(fs.readFileSync(file(), "utf8")).adopted).toEqual(winner.value);
});

test("a failed adoption replacement preserves the legacy file and can be retried explicitly", async () => {
  const original = JSON.stringify(legacy);
  fs.writeFileSync(file(), original);
  const ledger = new ThreadLedger(file());
  const rename = fs.renameSync;
  const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === file()) throw new Error("adoption rename failed");
    return rename(from, to);
  });
  try {
    await expect(ledger.adoptLegacy(A)).rejects.toThrow("adoption rename failed");
    expect(fs.readFileSync(file(), "utf8")).toBe(original);
    expect(fs.existsSync(`${file()}.lock`)).toBe(false);
  } finally {
    failure.mockRestore();
  }
  await ledger.adoptLegacy(A);
  expect(await ledger.list(A)).toEqual(legacy);
});

test("another account cannot advance an equal channel and root, even with a newer timestamp", async () => {
  const ledger = new ThreadLedger(file());
  await ledger.record(A, "C01", "1.000100", "2.000100");
  const original = fs.readFileSync(file(), "utf8");
  await ledger.markSeen(B, [{ channel: "C01", rootTs: "1.000100", ts: "9.000100" }]);
  expect(fs.readFileSync(file(), "utf8")).toBe(original);
  expect(await ledger.list(A)).toEqual([legacy[0]]);
});

test("invalid scopes and duplicate qualified routes never reset or rewrite the ledger", async () => {
  for (const doc of [
    { version: 2, threads: [{ ...legacy[0], scope: {} }] },
    {
      version: 2,
      threads: [
        { ...legacy[0], scope: A },
        { ...legacy[0], scope: A },
      ],
    },
    { version: 3, threads: [] },
  ]) {
    const original = JSON.stringify(doc);
    fs.writeFileSync(file(), original);
    const ledger = new ThreadLedger(file());
    await expect(ledger.list(A)).rejects.toThrow();
    await expect(ledger.record(A, "C03", "3.0", "3.0")).rejects.toThrow();
    expect(fs.readFileSync(file(), "utf8")).toBe(original);
  }
});
