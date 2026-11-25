import { expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import { dirname, join } from "node:path";

import { takeLock } from "../../skills/cataly-mode/scripts/src/checkpoint-lock.ts";
import { type EvidenceRef, fileEvidence } from "../../skills/cataly-mode/scripts/src/evidence.ts";
import { Registry } from "../../skills/cataly-mode/scripts/src/registry.ts";
import { Reports } from "../../skills/cataly-mode/scripts/src/reports.ts";
import { type FakePi, load, useConfig } from "./fake-pi";

const HEADLESS = "00000000-0000-4000-8000-000000000005";
const KEY = "receipt-race";
const ENV = ["CATALY_CONFIG", "CATALY_STATE_DIR", "CATALY_HEADLESS_ID"] as const;
const TEXTS: readonly string[] = ["first racer", "second racer"];
const MOVED = "1 of 1 evidence items are new; the evidence clock moved";
const STILL = "the same evidence was recorded before; the evidence clock did not move";
// Outlasts the registry's 5 s lock wait, so a racer that never reaches its append fails with its own error.
const TIMEOUT_MS = 15_000;

/** One journal acceptance, in evidenceSequence order, with the receipt and the evidence of the call that made it. */
type Accepted = {
  readonly sequence: number | undefined;
  readonly refs: readonly EvidenceRef[] | undefined;
  readonly text: string;
  /** The bytes' evidence as the test read it right before letting that racer in. */
  readonly expected: EvidenceRef | undefined;
  readonly receipt: string | undefined;
};

const line = (text: string, clock: string): string => `[REPORT] ${KEY} | milestone | ${text}\n${clock}`;

/**
 * Two cataly_report calls through the real tool race for the lane's real registry writer lock, which the test holds.
 * The cache-busted extension still shares node:fs. Observe each racer's EEXIST on the real lock path without
 * substituting either the lock or its result. Start the second racer only after the first captured its evidence and
 * hit that lock; `rewrite` changes the bytes in between. Releasing the lock lets the journal order both appenders.
 */
const race = async (rewrite?: string, switchSession = false): Promise<Accepted[]> => {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  const racers = TEXTS.map((text) => ({ text, arrived: Promise.withResolvers<void>() }));
  const context = new AsyncLocalStorage<(typeof racers)[number]>();
  const arrivals = new Set<string>();
  let lockPath: string | undefined;
  const open = fs.openSync;
  const spy = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
    try {
      return open(path, flags, mode);
    } catch (error) {
      const racer = context.getStore();
      if (path === lockPath && flags === "wx" && racer && (error as NodeJS.ErrnoException).code === "EEXIST") {
        arrivals.add(racer.text);
        racer.arrived.resolve();
      }
      throw error;
    }
  });
  const calls: Promise<string>[] = [];
  let release: (() => void) | undefined;
  let pi: FakePi | undefined;
  let root: string | undefined;
  try {
    const stateDir = useConfig();
    root = dirname(stateDir);
    process.env.CATALY_HEADLESS_ID = HEADLESS;
    const registry = new Registry(stateDir);
    await registry.write({
      key: KEY,
      title: "receipt race",
      thread: "none",
      sessionRef: { runtime: "headless", id: HEADLESS },
      brief: "/brief.md",
      done: "file /done.md",
      openedAt: "2026-01-01T00:00:00.000Z",
      reportProtocol: "jsonl-v1",
    });
    const journal = new Reports(stateDir).path(KEY);
    lockPath = `${registry.path(KEY)}.lock`;
    const source = join(root, "result.txt");
    fs.writeFileSync(source, "bytes read by the first racer");
    pi = await load({
      session: { id: "receipt-race", entries: [] },
      flags: { "cataly-role": "lane" },
      mode: "rpc",
      hasUI: true,
    });
    await pi.emit("session_start");
    const tool = pi.tools.get("cataly_report");
    if (!tool) throw new Error("cataly_report is not registered");
    // The lock code Registry.locked takes it with (as holdRegistry does); this live process owns it.
    const held = takeLock(lockPath, Date.now(), (message) => new Error(message));
    if (typeof held === "string") throw new Error(`registry lock is already held: ${held}`);
    release = held;
    const expected: EvidenceRef[] = [];
    for (const [index, racer] of racers.entries()) {
      if (index > 0 && rewrite !== undefined) fs.writeFileSync(source, rewrite);
      expected.push(fileEvidence(source, stateDir));
      const params = { kind: "milestone", text: racer.text, files: [source] };
      const ctx = pi.ctx();
      const call = context
        .run(racer, () => tool.execute(`race-${index}`, params, undefined, undefined, ctx))
        .then((out) => out.content.map((block) => block.text).join("\n"));
      calls.push(call);
      // A racer that returns or throws before its append waits on the lock ends the race instead of hanging it.
      const waiting = await Promise.race([racer.arrived.promise.then(() => true), call.then(() => false)]);
      if (!waiting) throw new Error(`${racer.text} returned before its journal append waited on the registry lock`);
    }
    expect([...arrivals]).toEqual([...TEXTS]);
    // Both fingerprints are captured and both appends wait: nothing is in the journal while the lock is still held.
    expect(fs.existsSync(journal)).toBe(false);
    if (switchSession) {
      pi.session = { id: "later-root-session", entries: [] };
      await pi.emit("session_switch", { reason: "new" });
    }
    release = undefined;
    held();
    if (switchSession) {
      await Promise.all(calls.map((call) => expect(call).rejects.toThrow("lane session changed before acceptance")));
      expect(fs.existsSync(journal)).toBe(false);
      return [];
    }
    const receipts = await Promise.all(calls);
    const records = [...(new Reports(stateDir).read(KEY)?.evidenced ?? [])].sort(
      (a, b) => (a.evidenceSequence ?? 0) - (b.evidenceSequence ?? 0),
    );
    return records.map((record) => {
      const index = TEXTS.indexOf(record.text);
      return {
        sequence: record.evidenceSequence,
        refs: record.evidenceRefs,
        text: record.text,
        expected: expected[index],
        receipt: receipts[index],
      };
    });
  } finally {
    spy.mockRestore();
    for (const racer of racers) racer.arrived.resolve();
    try {
      release?.();
    } finally {
      // A racer still waiting after a failure above finishes once the lock is gone, before the session and env go.
      await Promise.allSettled(calls);
      try {
        await pi?.emit("session_shutdown");
      } finally {
        for (const name of ENV) {
          const value = saved[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        if (root) fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
};

/** Both racers were accepted once each, in sequence 1 then 2, each with exactly the evidence it read. */
const acceptedBoth = (accepted: Accepted[]): void => {
  expect(accepted.map(({ text }) => text).sort()).toEqual([...TEXTS].sort());
  expect(accepted.map(({ sequence }) => sequence)).toEqual([1, 2]);
  expect(accepted.map(({ refs }) => refs)).toEqual(accepted.map(({ expected }) => (expected ? [expected] : [])));
};

test(
  "racing reports of the same file bytes: only the first accepted receipt says the evidence clock moved",
  async () => {
    const accepted = await race();
    acceptedBoth(accepted);
    const [first, second] = accepted.map(({ refs }) => refs);
    expect(second).toEqual(first);
    expect(accepted.map(({ receipt }) => receipt)).toEqual(
      accepted.map(({ text }, order) => line(text, order === 0 ? MOVED : STILL)),
    );
  },
  TIMEOUT_MS,
);

test(
  "racing reports of different bytes of the same file: both receipts say the evidence clock moved",
  async () => {
    const accepted = await race("different, longer bytes read by the second racer after the first one waits");
    acceptedBoth(accepted);
    const [before, after] = TEXTS.map((text) => accepted.find((entry) => entry.text === text)?.expected);
    if (!before || !after) throw new Error("a racer's evidence was not accepted");
    expect(after.ref).toBe(before.ref);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(accepted.map(({ receipt }) => receipt)).toEqual(accepted.map(({ text }) => line(text, MOVED)));
  },
  TIMEOUT_MS,
);

test(
  "reports waiting on the lane writer stay held when the originating session changes",
  async () => expect(await race(undefined, true)).toEqual([]),
  TIMEOUT_MS,
);
