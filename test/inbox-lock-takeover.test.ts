import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { takeInboxLock } from "../src/inbox-lock.ts";

const REAL_READ = fs.readFileSync;
const REAL_LINK = fs.linkSync;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => mock.restore());

/** A lock left by a process that died on this host: stale for every reader. */
async function staleLock(path: string): Promise<string> {
  const exited = Bun.spawn(["true"]);
  await exited.exited;
  const stale = JSON.stringify({ pid: exited.pid, host: hostname(), at: 0 });
  writeFileSync(path, stale);
  return stale;
}

test("a takeover paused after reading a stale lock never frees or removes the lock another process took over", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "dori-lock-")), "inbox.jsonl.lock");
  const stale = await staleLock(path);
  // P reads the stale lock, then pauses: Q takes it over meanwhile. Whatever P does next, a third taker R, trying at
  // any point P touches the lock again, must find it held by Q.
  let q: (() => void) | undefined;
  let r: (() => void) | undefined;
  let paused = true;
  spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const read = (REAL_READ as (...a: unknown[]) => unknown)(file, ...rest);
    if (paused && String(file) === path && read === stale) {
      paused = false;
      q = takeInboxLock(path, 1);
    }
    return read;
  }) as never);
  spyOn(fs, "linkSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === path) r ??= takeInboxLock(path, 1);
    return REAL_LINK(from, to);
  }) as never);

  const p = takeInboxLock(path, 1);
  r ??= takeInboxLock(path, 1);
  mock.restore();

  expect(q).toBeDefined();
  expect({ p, r }).toEqual({ p: undefined, r: undefined });
  expect(JSON.parse(REAL_READ(path, "utf8") as string)).toEqual({
    pid: process.pid,
    host: hostname(),
    at: 1,
    nonce: expect.stringMatching(UUID),
  });
  q?.();
  expect(fs.existsSync(path)).toBe(false);
});

test("a takeover whose claimer died is finished by the next taker, once, and leaves no claim behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-lock-"));
  const path = join(dir, "inbox.jsonl.lock");
  const stale = await staleLock(path);
  // The claim of a process that died part way through taking over the stale lock: itself stale.
  const exited = Bun.spawn(["true"]);
  await exited.exited;
  const digest = new Bun.CryptoHasher("sha256").update(basename(path)).update("\0").update(stale).digest("hex");
  writeFileSync(join(dir, `.inbox-claim-${digest}`), JSON.stringify({ pid: exited.pid, host: hostname(), at: 0 }));

  const next = takeInboxLock(path, 1);

  expect(next).toBeDefined();
  expect(takeInboxLock(path, 1)).toBeUndefined();
  next?.();
  expect(fs.readdirSync(dir)).toEqual([]);
});
