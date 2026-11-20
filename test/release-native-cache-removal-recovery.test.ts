import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { leaseNativeIdentity } from "../src/release/native-cache-lease.ts";
import { cachePending } from "../src/release/native-cache-quarantine.ts";
import { processFiles } from "../src/release/process-files.ts";
import { keptFor, pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";
import { nativeCacheFixture, ownProcessCwds } from "./source-bundle-setup.ts";

afterEach(removePruneFixtures);
// POSIX-only: cache validation checks permission bits and owner uids. Partial removal also requires a non-root user.
const posix = test.skipIf(process.platform === "win32");
const nonRoot = test.skipIf(process.platform === "win32" || process.getuid?.() === 0);
// These fixtures open descriptors in this process only. Run the real reader
// without scanning unrelated host processes on every prune and recovery pass.
const fixtureFiles = () =>
  process.platform === "linux" ? processFiles("linux", [String(process.pid)]) : { files: new Map(), unread: [] };

// All inputs use the original public prune/fixture APIs, including the fresh files callback. No rm implementation is
// replaced: a real owned, nonempty, unreadable subtree makes native recursive removal fail after unlinking files.
function partialRemoval() {
  const c = pruneFixture(fixtureFiles);
  const x = c.native("partial", true);
  const backup = join(c.root, "saved-source");
  renameSync(x.source, backup);
  writeFileSync(join(x.directory, "00-removal-payload"), "must be unlinked by native rm\n");
  // Native enumeration is not lexical. On reverse-insertion filesystems, move
  // the marker files out and back so the blocker can be visited last there too.
  const markers = ["receipt.json", "00-removal-payload"];
  const blocker = Array.from({ length: 256 }, (_, i) => `removal-blocked-${i}`).find((name, i) => {
    const directory = join(x.directory, name);
    const visitsMarkerFilesFirst = () => {
      const order = readdirSync(x.directory);
      return markers.every((marker) => order.indexOf(marker) < order.indexOf(name));
    };
    mkdirSync(directory);
    if (visitsMarkerFilesFirst()) return true;
    if (i === 0) {
      for (const marker of markers) {
        const path = join(x.directory, marker);
        const moved = join(c.root, marker);
        renameSync(path, moved);
        renameSync(moved, path);
      }
      if (visitsMarkerFilesFirst()) return true;
    }
    rmdirSync(directory);
    return false;
  });
  if (!blocker) throw new Error("Native removal fixture could not place its blocking subtree after both marker files");
  writeFileSync(join(x.directory, blocker, "retained"), "must survive the permission failure\n");
  c.prune({ now: 0 });
  const cache = join(c.home, ".cache/omp-dori");
  const prefix = `${basename(x.directory)}.`;
  let blocked = false;
  let failure: unknown;
  try {
    c.prune({
      now: 1,
      deleteQuarantined: true,
      files: () => {
        for (const name of readdirSync(cache)) {
          if (!name.startsWith(`${prefix}deleting-`)) continue;
          // The byte scan has finished; this callback runs at the final, fresh process-file check.
          chmodSync(join(cache, name, blocker), 0);
          blocked = true;
        }
        return fixtureFiles();
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    // The candidate has renamed .deleting to its committed name; the rejected implementation has not.
    for (const name of readdirSync(cache)) {
      const path = join(cache, name, blocker);
      if (name.startsWith(prefix) && existsSync(path)) chmodSync(path, 0o700);
    }
  }
  expect(blocked).toBe(true);
  const failureCode = (failure as NodeJS.ErrnoException | undefined)?.code;
  // Darwin's recursive rmSync reports the blocked subtree as ENOTEMPTY where Linux reports EACCES.
  expect(
    failureCode === "EACCES" ||
      failureCode === "EPERM" ||
      (process.platform === "darwin" && failureCode === "ENOTEMPTY"),
  ).toBe(true);
  const left = readdirSync(cache).filter((name) => name.startsWith(prefix));
  expect(left).toHaveLength(1);
  const remainder = join(cache, left[0]!);
  // These assertions distinguish an actual partial rm from an intact pre-check interruption or an unrelated error.
  expect(existsSync(join(remainder, "receipt.json"))).toBe(false);
  expect(existsSync(join(remainder, "00-removal-payload"))).toBe(false);
  expect(readFileSync(join(remainder, blocker, "retained"), "utf8")).toContain("must survive");
  return { c, x, backup, cache, remainder, blocker };
}

nonRoot("partial removal never returns to live; explicit cleanup preserves a newly prepared image", () => {
  const f = partialRemoval();
  const ordinary = f.c.prune({ now: 2 });
  expect(ordinary.removed).toEqual([]);
  expect(existsSync(f.x.directory)).toBe(false);
  expect(existsSync(f.remainder)).toBe(true);
  expect(keptFor(ordinary, f.remainder)).toContain("committed removal; --delete-quarantined is required to continue");
  expect(cachePending(f.c.home)).toEqual([
    expect.objectContaining({ directory: f.remainder, identity: f.x.identity, state: "removing" }),
  ]);
  // Re-prepare the same identity through the original real-Git fixture builder while the damaged remainder stays aside.
  renameSync(f.backup, f.x.source);
  const healthy = nativeCacheFixture(f.x.source, f.c.home, join(f.c.root, "upstream-partial"));
  expect(healthy.identity).toBe(f.x.identity);
  expect(healthy.directory).toBe(f.x.directory);
  const receipt = readFileSync(join(healthy.directory, "receipt.json"), "utf8");
  const launcher = readFileSync(healthy.omp, "utf8");
  const cleaned = f.c.prune({ now: 3, graceMs: 600_000, deleteQuarantined: true });
  expect(cleaned.removed.map((entry) => entry.directory)).toEqual([f.remainder]);
  expect(existsSync(f.remainder)).toBe(false);
  expect(readFileSync(join(healthy.directory, "receipt.json"), "utf8")).toBe(receipt);
  expect(readFileSync(healthy.omp, "utf8")).toBe(launcher);
  expect(cachePending(f.c.home)).toEqual([]);
});

posix("successful explicit removal still removes the unused copy and its quarantine record", () => {
  const c = pruneFixture();
  const x = c.native("success");
  expect(c.prune({ now: 0 }).removed).toEqual([]);
  const removed = c.prune({ now: 1, deleteQuarantined: true });
  expect(removed.removed.map((entry) => entry.directory)).toEqual([x.directory]);
  expect(readdirSync(join(c.home, ".cache/omp-dori")).filter((name) => name.includes(x.identity))).toEqual([]);
  expect(cachePending(c.home)).toEqual([]);
});

posix("an intact pre-check deleting copy still restores when a reference appears", () => {
  const c = pruneFixture();
  const x = c.native("intact");
  c.prune({ now: 0 });
  renameSync(`${x.directory}.pruning`, `${x.directory}.deleting-0123456789abcdef`);
  writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
  const recovered = c.prune({ now: 1 });
  expect(recovered.removed).toEqual([]);
  expect(keptFor(recovered, x.directory)).toContain("put back from quarantine");
  expect(existsSync(x.omp)).toBe(true);
  expect(cachePending(c.home)).toEqual([]);
});

nonRoot("a committed retry uses fresh unknown-file holds and never restores the damaged copy", () => {
  const f = partialRemoval();
  let reads = 0;
  const held = f.c.prune({ deleteQuarantined: true, files: () => (++reads === 1 ? fixtureFiles() : null) });
  expect(reads).toBeGreaterThan(1);
  expect(held.removed).toEqual([]);
  expect(keptFor(held, f.remainder)).toContain("open files of processes unavailable");
  expect(existsSync(f.remainder)).toBe(true);
  expect(existsSync(f.x.directory)).toBe(false);
});

for (const prefix of ["", ".pruning", ".deleting-", ".removing-"]) {
  nonRoot(`a fresh ${prefix || "live"} reference keeps the committed copy terminal`, () => {
    const f = partialRemoval();
    const suffix = prefix.endsWith("-") ? `${prefix}${f.remainder.slice(-16)}` : prefix;
    const reference = join(f.c.refs, "late-reference");
    let scans = 0;
    const held = f.c.prune({
      deleteQuarantined: true,
      readCwds: (pids) => {
        if (++scans === 1) writeFileSync(reference, `${f.x.directory}${suffix}/bin/omp\n`);
        return ownProcessCwds(pids);
      },
    });
    expect(scans).toBeGreaterThan(1);
    expect(held.removed).toEqual([]);
    expect(keptFor(held, f.remainder)).toContain(`reference ${reference}`);
    expect(existsSync(f.remainder)).toBe(true);
    expect(existsSync(f.x.directory)).toBe(false);
    rmSync(reference);
  });
}

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "a live lease holds a committed remainder in place",
  () => {
    const f = partialRemoval();
    leaseNativeIdentity(f.c.home, f.x.identity);
    const leased = f.c.prune({ deleteQuarantined: true });
    expect(keptFor(leased, f.remainder)).toContain(`lease of process ${process.pid}`);
    expect(leased.removed).toEqual([]);
    rmSync(join(f.cache, "native-leases"), { recursive: true });
  },
);

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "an actual open descriptor holds a committed remainder until closed",
  () => {
    const f = partialRemoval();
    const fd = openSync(join(f.remainder, f.blocker, "retained"), "r");
    try {
      const held = f.c.prune({ deleteQuarantined: true });
      expect(held.removed).toEqual([]);
      expect(keptFor(held, f.remainder)).toContain(`process ${process.pid} has it open, mapped or running`);
      expect(existsSync(f.x.directory)).toBe(false);
    } finally {
      closeSync(fd);
    }
    expect(f.c.prune({ deleteQuarantined: true }).removed.map((entry) => entry.directory)).toEqual([f.remainder]);
  },
);

posix("committed cleanup refuses linked or writable cache children without touching their contents", () => {
  const c = pruneFixture();
  const x = c.native("unsafe");
  const outside = join(c.root, "outside");
  const terminal = `${x.directory}.removing-0123456789abcdef`;
  renameSync(x.directory, outside);
  symlinkSync(outside, terminal);
  expect(() => c.prune({ deleteQuarantined: true })).toThrow("Unsafe directory");
  expect(existsSync(join(outside, "receipt.json"))).toBe(true);
  rmSync(terminal);
  renameSync(outside, terminal);
  chmodSync(terminal, 0o777);
  try {
    expect(() => c.prune({ deleteQuarantined: true })).toThrow("Group/world-writable installation path");
    expect(existsSync(join(terminal, "receipt.json"))).toBe(true);
  } finally {
    chmodSync(terminal, 0o700);
  }
});
