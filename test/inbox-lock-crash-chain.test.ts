import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { takeInboxLock } from "../src/inbox-lock.ts";

const REAL_WRITE = fs.writeFileSync;
const fixture = join(import.meta.dir, "fixtures", "inbox-lock-reclaimer.test.ts");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => mock.restore());

test("three crashed reclaimers leave actual claims that a fourth taker recovers with bounded names", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "dori-inbox-crash-"));
  const path = join(dir, "w1_p2.jsonl.lock");
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  const stale = JSON.stringify({ pid: dead.pid, host: hostname(), at: 0 });
  fs.writeFileSync(path, stale);
  const claims = new Set<string>();
  let release: (() => void) | undefined;
  let replacement: (() => void) | undefined;

  try {
    for (let i = 1; i <= 3; i++) {
      const reclaimer = Bun.spawn([process.execPath, "test", fixture], {
        env: { ...process.env, DORI_TEST_INBOX_RECLAIMER: JSON.stringify({ path, now: i }) },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2_000,
        killSignal: "SIGKILL",
      });
      const [code, stdout, stderr] = await Promise.all([
        reclaimer.exited,
        new Response(reclaimer.stdout).text(),
        new Response(reclaimer.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`reclaimer ${i} exited ${code}: ${stderr}`);
      const reports = stdout.split("\n").filter((line) => line.startsWith("INBOX_CLAIM "));
      expect(reports).toHaveLength(1);
      const report = JSON.parse(reports[0]!.slice("INBOX_CLAIM ".length)) as { claim: string; content: string };
      expect(report.claim).not.toBe(path);
      expect(fs.readFileSync(report.claim, "utf8")).toBe(report.content);
      expect(JSON.parse(report.content)).toEqual({
        pid: reclaimer.pid,
        host: hostname(),
        at: i,
        nonce: expect.stringMatching(UUID),
      });
      expect(Buffer.byteLength(basename(report.claim))).toBeLessThanOrEqual(255);
      claims.add(report.claim);
      expect(claims.size).toBe(i);
      expect(fs.readFileSync(path, "utf8")).toBe(stale);
      for (const claim of claims) expect(fs.existsSync(claim)).toBe(true);
    }

    // Every claim above was produced by takeInboxLock and belongs to a confirmed-exited process.
    release = takeInboxLock(path, 10);
    expect(release).toBeDefined();
    expect(takeInboxLock(path, 11)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({
      pid: process.pid,
      host: hostname(),
      at: 10,
      nonce: expect.stringMatching(UUID),
    });
    for (const name of fs.readdirSync(dir)) expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    release?.();
    expect(fs.readdirSync(dir)).toEqual([]);

    replacement = takeInboxLock(path, 12);
    expect(replacement).toBeDefined();
    const owner = fs.readFileSync(path, "utf8");
    expect(JSON.parse(owner)).toEqual({
      pid: process.pid,
      host: hostname(),
      at: 12,
      nonce: expect.stringMatching(UUID),
    });
    // A delayed release from the previous owner must not remove the new owner.
    release?.();
    expect(fs.readFileSync(path, "utf8")).toBe(owner);
    expect(takeInboxLock(path, 13)).toBeUndefined();
    replacement?.();
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    replacement?.();
    release?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("physical directory aliases share one stale-claim namespace", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "dori-inbox-alias-"));
  const physical = join(dir, "physical");
  fs.mkdirSync(physical);
  const alias = join(dir, "alias");
  fs.symlinkSync(physical, alias, "dir");
  const path = join(physical, "w1_p2.jsonl.lock");
  const aliasPath = join(alias, "w1_p2.jsonl.lock");
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  const stale = JSON.stringify({ pid: dead.pid, host: hostname(), at: 0 });
  fs.writeFileSync(path, stale);
  let probed = false;
  let owner: (() => void) | undefined;
  let rival: (() => void) | undefined;

  try {
    spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      REAL_WRITE(file, data, options);
      if (!probed && String(file) !== path) {
        probed = true;
        // The real claim exists, its pid is alive, and its taker has not removed the stale root yet.
        expect(fs.readFileSync(path, "utf8")).toBe(stale);
        rival = takeInboxLock(aliasPath, 20);
      }
    });
    owner = takeInboxLock(path, 10);
    mock.restore();

    expect(probed).toBe(true);
    expect(rival).toBeUndefined();
    expect(owner).toBeDefined();
    expect(JSON.parse(fs.readFileSync(aliasPath, "utf8"))).toEqual({
      pid: process.pid,
      host: hostname(),
      at: 10,
      nonce: expect.stringMatching(UUID),
    });
    expect(takeInboxLock(aliasPath, 21)).toBeUndefined();
    owner?.();
    expect(fs.readdirSync(physical)).toEqual([]);
  } finally {
    mock.restore();
    rival?.();
    owner?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a prior release cannot remove a replacement acquired in the same timestamp", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "dori-inbox-same-time-"));
  const path = join(dir, "w1_p2.jsonl.lock");
  let first: (() => void) | undefined;
  let second: (() => void) | undefined;
  try {
    first = takeInboxLock(path, 10);
    expect(first).toBeDefined();
    const firstOwner = fs.readFileSync(path, "utf8");
    expect(JSON.parse(firstOwner)).toEqual({
      pid: process.pid,
      host: hostname(),
      at: 10,
      nonce: expect.stringMatching(UUID),
    });
    first?.();
    second = takeInboxLock(path, 10);
    expect(second).toBeDefined();
    const owner = fs.readFileSync(path, "utf8");
    expect(JSON.parse(owner)).toEqual({
      pid: process.pid,
      host: hostname(),
      at: 10,
      nonce: expect.stringMatching(UUID),
    });
    expect(owner).not.toBe(firstOwner);
    first?.();
    expect(fs.existsSync(path)).toBe(true);
    expect(fs.readFileSync(path, "utf8")).toBe(owner);
    expect(takeInboxLock(path, 11)).toBeUndefined();
    second?.();
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    second?.();
    first?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
