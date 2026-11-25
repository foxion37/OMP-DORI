import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { leaseNativeIdentity } from "../src/release/native-cache-lease.ts";
import type { processCwds } from "../src/release/process-cwd.ts";
import { keptFor, pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";
import { ownProcessCwds, ownProcessFiles } from "./source-bundle-setup.ts";

// Quarantine and its second prune: writers, other prunes, errors and copies an earlier prune left behind.

afterEach(removePruneFixtures);

// POSIX-only: the cache refuses group/world-writable paths, which Windows reports for every file and directory.
const posix = test.skipIf(process.platform === "win32");

/** The fixture's reader, with `hook(n)` run at this prune's n-th process scan. */
const scans = (hook: (scan: number) => void): typeof processCwds => {
  let scan = 0;
  return (pids) => {
    hook(++scan);
    return ownProcessCwds(pids);
  };
};
/** A writer from this release: it leases, sees the prune holding the lock (no wait here) and publishes only after. */
const leaseDuringPrune = (home: string, identity: string) => {
  expect(() => leaseNativeIdentity(home, identity, process.pid, 0)).toThrow("A native cache prune");
};

// Contract (owner decision, R1): a prune never removes an identity by itself; only --delete-quarantined does, after
// the grace period. The removal steps below therefore ask for it.
posix(
  "a prune quarantines what nothing uses; only an asked prune after the grace period removes it, and says why",
  () => {
    // Synchronous fixture setup leaves no live child; this grace-period case has no external file holder.
    const c = pruneFixture(() => ownProcessFiles([String(process.pid)]));
    const free = c.native("free");
    const used = c.native("used");
    writeFileSync(join(c.refs, "omp"), c.wrapper(used.omp));
    const first = c.prune({ graceMs: 60_000, now: 0 });
    expect(first.removed).toEqual([]);
    expect(first.quarantined).toEqual([
      expect.objectContaining({
        directory: free.directory,
        since: new Date(0).toISOString(),
        removableAfter: new Date(60_000).toISOString(),
      }),
    ]);
    expect(keptFor(first, used.directory)).toEqual([`reference ${join(c.refs, "omp")}`]);
    expect(existsSync(free.directory)).toBe(false);
    expect(existsSync(`${free.directory}.pruning/bin/omp`)).toBe(true);
    // Within the grace period it only waits.
    expect(c.prune({ graceMs: 60_000, now: 59_999 }).quarantined.map((entry) => entry.directory)).toEqual([
      free.directory,
    ]);
    // Past the grace period an ordinary prune still only waits.
    expect(c.prune({ graceMs: 60_000, now: 60_000 }).removed).toEqual([]);
    const later = c.prune({ graceMs: 60_000, now: 60_000, deleteQuarantined: true });
    expect(later.removed).toEqual([
      expect.objectContaining({
        directory: free.directory,
        identity: free.identity,
        why: expect.stringContaining("removal asked"),
      }),
    ]);
    expect(later.removed[0]!.bytes).toBeGreaterThan(0);
    expect(readdirSync(join(c.home, ".cache/omp-cataly")).filter((name) => name.includes(free.identity))).toEqual([]);
    expect(existsSync(used.omp)).toBe(true);
  },
);

posix.each([1, 2])("A9/B7 a writer that leases during prune %i keeps its identity, or gets it back", (at) => {
  const c = pruneFixture();
  const x = c.native("x");
  if (at === 2) c.prune();
  const result = c.prune({ readCwds: scans((scan) => scan === 1 && leaseDuringPrune(c.home, x.identity)) });
  // The writer waited for the lock and publishes now; the identity it leased is in place.
  writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
  expect(result.removed).toEqual([]);
  expect(keptFor(result, x.directory)).toContain(`lease of process ${process.pid}`);
  expect(existsSync(x.omp)).toBe(true);
});

posix("B8/P3 a second prune while one runs is refused, in this process or another", () => {
  const c = pruneFixture();
  const x = c.native("x");
  c.prune();
  const module = resolve(import.meta.dir, "../src/release/native-cache-prune.ts");
  const code = `const { pruneNativeCache } = await import(${JSON.stringify(module)}); pruneNativeCache(process.argv[1], [], [process.argv[2]], { table: () => "", graceMs: 0 });`;
  let inner: unknown;
  let child: { exitCode: number | null; stderr: string } | undefined;
  const result = c.prune({
    readCwds: scans((scan) => {
      if (scan !== 1) return;
      writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
      try {
        c.prune();
      } catch (error) {
        inner = error;
      }
      const run = Bun.spawnSync([process.execPath, "-e", code, c.home, c.refs], { stdout: "pipe", stderr: "pipe" });
      child = { exitCode: run.exitCode, stderr: run.stderr.toString() };
    }),
  });
  expect(String(inner)).toContain("Another native cache prune holds");
  expect(child?.exitCode).not.toBe(0);
  expect(child?.stderr).toContain("Another native cache prune holds");
  expect(keptFor(result, x.directory)).toContain(`reference ${join(c.refs, "omp")}`);
  expect(existsSync(x.omp)).toBe(true);
});

posix("B9 an error during the look leaves every copy quarantined, and a later prune puts back what is used", () => {
  const c = pruneFixture();
  const x = c.native("x");
  c.prune();
  const failing = scans((scan) => {
    if (scan === 1) throw new Error("process scan unavailable");
  });
  expect(() => c.prune({ readCwds: failing })).toThrow("process scan unavailable");
  expect(existsSync(`${x.directory}.pruning/bin/omp`)).toBe(true);
  writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
  expect(keptFor(c.prune(), x.directory)).toContain("put back from quarantine");
  expect(existsSync(x.omp)).toBe(true);
});

posix("B9 a reference that cannot be read stops the prune; once readable it puts the copy back", () => {
  if (process.getuid?.() === 0) return;
  const c = pruneFixture();
  const x = c.native("x");
  c.prune();
  const reference = join(c.refs, "private");
  writeFileSync(reference, x.omp);
  chmodSync(reference, 0);
  try {
    expect(() => c.prune()).toThrow("EACCES");
  } finally {
    chmodSync(reference, 0o600);
  }
  expect(existsSync(`${x.directory}.pruning/bin/omp`)).toBe(true);
  // Only this identity's own reasons are checked: the host's processes are read too and may add to them.
  expect(keptFor(c.prune(), x.directory)).toEqual(
    expect.arrayContaining([`reference ${reference}`, "put back from quarantine"]),
  );
  expect(existsSync(x.omp)).toBe(true);
});

posix("P4/P6 a quarantined copy is never removed while its live name exists again", () => {
  const c = pruneFixture();
  const x = c.native("x");
  c.prune();
  // An older launcher prepares the live name again while the copy is quarantined.
  mkdirSync(x.directory);
  writeFileSync(join(c.refs, "note"), `${x.directory}.pruning/bin/omp\n`);
  for (const result of [c.prune(), c.prune()])
    expect(keptFor(result, `${x.directory}.pruning`)?.at(-1)).toContain("its live name exists again");
  expect(existsSync(`${x.directory}.pruning/bin/omp`)).toBe(true);
});

posix("a copy moved aside without a quarantine record starts its grace period when a prune finds it", () => {
  const c = pruneFixture();
  const x = c.native("x");
  renameSync(x.directory, `${x.directory}.pruning`);
  const found = c.prune({ graceMs: 60_000, now: 5_000 });
  expect(found.quarantined).toEqual([
    expect.objectContaining({ directory: x.directory, since: new Date(5_000).toISOString() }),
  ]);
  writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
  expect(keptFor(c.prune(), x.directory)).toEqual(
    expect.arrayContaining([`reference ${join(c.refs, "omp")}`, "put back from quarantine"]),
  );
  expect(existsSync(x.omp)).toBe(true);
});

posix(
  "a copy an interrupted removal left (.deleting-<nonce>) goes back into quarantine, never removed unchecked",
  () => {
    const c = pruneFixture();
    const x = c.native("x");
    c.prune();
    renameSync(`${x.directory}.pruning`, `${x.directory}.deleting-0123456789abcdef`);
    const result = c.prune();
    expect(result.removed).toEqual([]);
    expect(result.quarantined.map((entry) => entry.directory)).toEqual([x.directory]);
    expect(existsSync(`${x.directory}.pruning/bin/omp`)).toBe(true);
  },
);

posix("a running Cataly writer for this cache or an older writer's preparation keeps every identity", () => {
  const c = pruneFixture();
  const x = c.native("x");
  const uid = process.getuid?.() ?? 0;
  // An older checkout's launcher for this home; one for another home works on another cache.
  const writer = `bun /old/scripts/source-dependencies.ts assert-native /old ${c.home}`;
  const other = `bun /old/scripts/source-dependencies.ts native /old ${c.refs}`;
  const held = c.prune({ table: () => `4242 ${uid} ${writer}\n4343 ${uid} ${other}\n` });
  expect(keptFor(held, x.directory)).toEqual([`Cataly cache writer process 4242 (${writer})`]);
  const stage = join(c.home, ".cache/omp-cataly/native-stage-abc123");
  mkdirSync(stage);
  expect(keptFor(c.prune(), x.directory)).toEqual([`native preparation of an older writer ${stage}`]);
  expect(existsSync(x.omp)).toBe(true);
});
