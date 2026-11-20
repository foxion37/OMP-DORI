import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { takeFile, underClaim } from "../src/lock-claim.ts";
import { OWNERLESS_MS } from "../src/lock-owner.ts";
import { lockEnv } from "../src/lock.ts";

const fixture = join(import.meta.dir, "fixtures", "lock-claim-reclaimer.test.ts");

/** Discover one production-written file left by a confirmed-exited owner, without predicting its claim name. */
async function crashed(path: string, claim: boolean) {
  const dir = dirname(path);
  const before = new Set(readdirSync(dir));
  const child = Bun.spawn([process.execPath, "test", fixture], {
    env: { ...process.env, DORI_TEST_LOCK_RECLAIMER: JSON.stringify({ path, claim }) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2_000,
    killSignal: "SIGKILL",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 71) throw new Error(`producer exited ${code}: ${stderr}\n${stdout}`);
  expect(lockEnv(dir).alive(child.pid)).toBe(false);
  const added = readdirSync(dir).filter((name) => !before.has(name));
  expect(added).toHaveLength(1);
  const actualPath = join(dir, added[0]!);
  if (!claim) expect(actualPath).toBe(path);
  const content = readFileSync(actualPath, "utf8");
  expect(/^pid=(\d+) \S+$/.exec(content)?.[1]).toBe(String(child.pid));
  return { path: actualPath, content };
}

test("eleven actual exited owners and reclaimers recover with bounded claims and exact releases", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-claim-chain-"));
  const path = join(root, ".guard");
  const env = lockEnv(root);
  let release: (() => void) | undefined;
  let replacement: (() => void) | undefined;
  try {
    // A live file owner is never reclaimed, regardless of the recovery chain exercised below.
    release = takeFile(env, path, OWNERLESS_MS);
    expect(release).toBeDefined();
    const control = readFileSync(path, "utf8");
    expect(takeFile(env, path, OWNERLESS_MS)).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(control);
    release?.();

    const chain: { path: string; content: string }[] = [];
    let next = path;
    for (let depth = 0; depth <= 10; depth++) {
      const produced = await crashed(next, depth !== 0);
      chain.push(produced);
      next = produced.path;
      for (const prior of chain) expect(readFileSync(prior.path, "utf8")).toBe(prior.content);
    }

    release = takeFile(env, path, OWNERLESS_MS);
    expect(release).toBeDefined();
    for (const claim of chain.slice(1)) {
      expect(basename(claim.path)).toMatch(/^\.lock-claim-[0-9a-f]{64}$/);
      expect(Buffer.byteLength(basename(claim.path))).toBe(76);
    }
    expect(readdirSync(root)).toEqual([basename(path)]);
    expect(takeFile(env, path, OWNERLESS_MS)).toBeUndefined();
    release?.();
    expect(readdirSync(root)).toEqual([]);

    replacement = takeFile(env, path, OWNERLESS_MS);
    expect(replacement).toBeDefined();
    const owner = readFileSync(path, "utf8");
    // A delayed release from the same process must leave the replacement's unique receipt intact.
    release?.();
    expect(readFileSync(path, "utf8")).toBe(owner);
    expect(takeFile(env, path, OWNERLESS_MS)).toBeUndefined();
    replacement?.();
    expect(readdirSync(root)).toEqual([]);
  } finally {
    replacement?.();
    release?.();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("physical directory aliases share the actual stale snapshot's live claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-claim-alias-"));
  const physical = join(root, "physical");
  mkdirSync(physical);
  const alias = join(root, "alias");
  symlinkSync(physical, alias, "dir");
  const path = join(physical, ".guard");
  const aliasPath = join(alias, basename(path));
  const env = lockEnv(physical);
  let release: (() => void) | undefined;
  let rival: (() => void) | undefined;
  try {
    const stale = await crashed(path, false);
    let entered = false;
    expect(
      underClaim(env, path, stale.content, OWNERLESS_MS, () => {
        entered = true;
        rival = takeFile(env, aliasPath, OWNERLESS_MS);
        expect(rival).toBeUndefined();
        expect(readFileSync(path, "utf8")).toBe(stale.content);
        expect(readdirSync(physical)).toHaveLength(2);
      }),
    ).toBe(true);
    expect(entered).toBe(true);
    expect(readFileSync(aliasPath, "utf8")).toBe(stale.content);
    expect(readdirSync(physical)).toEqual([basename(path)]);

    release = takeFile(env, aliasPath, OWNERLESS_MS);
    expect(release).toBeDefined();
    const owner = readFileSync(path, "utf8");
    expect(owner).not.toBe(stale.content);
    expect(takeFile(env, path, OWNERLESS_MS)).toBeUndefined();
    expect(readFileSync(aliasPath, "utf8")).toBe(owner);
    release?.();
    expect(readdirSync(physical)).toEqual([]);
  } finally {
    rival?.();
    release?.();
    rmSync(root, { recursive: true, force: true });
  }
});
