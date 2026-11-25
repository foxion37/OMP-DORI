import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeReceipt } from "../src/release/native.ts";
import { processCwds } from "../src/release/process-cwd.ts";
import { keptFor, type PruneFixture, pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";
import { overlayFixture } from "./source-bundle-setup.ts";

// Reviewer counterexamples (Astra audit F3-F5, Astra and Fable reviews of the first prune): each identity is in use, or
// its use cannot be ruled out, so a prune must keep it and say why.

afterEach(removePruneFixtures);

// POSIX-only: the cache refuses group/world-writable paths, which Windows reports for every file and directory.
const posix = test.skipIf(process.platform === "win32");

type Case = {
  readonly keepSource?: boolean;
  /** Arranges the use; returns the extra roots to scan, the reason expected and how to undo a permission change. */
  readonly arrange: (c: PruneFixture, x: NativeReceipt) => { more?: string[]; reason: string; undo?: () => void };
};

const MIB = 1024 * 1024;
const outsideDir = (c: PruneFixture) => {
  const outside = join(c.root, "outside");
  mkdirSync(outside, { recursive: true });
  return outside;
};
const referenceFile = (large: boolean, linked: boolean): Case => ({
  arrange: (c, x) => {
    const text = `${JSON.stringify({ omp: x.omp })}${large ? " ".repeat(MIB) : ""}`;
    const target = join(linked ? outsideDir(c) : c.refs, "release.json");
    writeFileSync(target, text);
    if (linked) symlinkSync(target, join(c.refs, "release.json"));
    return { reason: `reference ${join(c.refs, "release.json")}` };
  },
});
const unscanned = (lock: string | undefined): Case => ({
  arrange: (c, x) => {
    const outside = outsideDir(c);
    writeFileSync(join(outside, "omp"), c.wrapper(x.omp));
    if (lock !== undefined) writeFileSync(join(outside, "native-omp.lock"), lock);
    symlinkSync(outside, join(c.refs, "wrappers"));
    return { reason: `link to an unscanned directory ${join(c.refs, "wrappers")}` };
  },
});

const CASES: Record<string, Case> = {
  "A1 a small reference file": referenceFile(false, false),
  "A2 (F3) a reference file over 1 MiB": referenceFile(true, false),
  "A3 a small reference file behind a link": referenceFile(false, true),
  "A4 (F3) a reference file over 1 MiB behind a link": referenceFile(true, true),
  "A5 a link to an unscanned directory without a lock": unscanned(undefined),
  "A6 (F4) a link to an unscanned directory whose lock is invalid": unscanned("{}"),
  "A7 a wrapper in a directory scanned as an explicit root": {
    arrange: (c, x) => {
      const outside = outsideDir(c);
      writeFileSync(join(outside, "omp"), c.wrapper(x.omp));
      symlinkSync(outside, join(c.refs, "wrappers"));
      return { more: [outside], reason: `reference ${join(outside, "omp")}` };
    },
  },
  "A8 a wrapper written before the scan": {
    arrange: (c, x) => {
      writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
      return { reason: `reference ${join(c.refs, "omp")}` };
    },
  },
  "B1/P2 a linked directory with a valid lock of another identity holding a wrapper": {
    arrange: (c, x) => {
      const other = overlayFixture(join(c.root, "other"), join(c.root, "other-upstream"), `other-identity ${c.root}`);
      writeFileSync(join(other.source, "omp"), c.wrapper(x.omp));
      symlinkSync(other.source, join(c.refs, "release"));
      return { reason: `link to an unscanned directory ${join(c.refs, "release")}` };
    },
  },
  "B2 a link inside a root into a node_modules the walk skips": {
    arrange: (c, x) => {
      const hidden = join(c.refs, "node_modules/wrapper");
      mkdirSync(hidden, { recursive: true });
      writeFileSync(join(hidden, "omp"), c.wrapper(x.omp));
      symlinkSync(hidden, join(c.refs, "active"));
      return { reason: `link to an unscanned directory ${join(c.refs, "active")}` };
    },
  },
  "B3 a link whose target cannot be reached (EACCES), not a dangling one": {
    arrange: (c, x) => {
      const outside = outsideDir(c);
      writeFileSync(join(outside, "omp"), c.wrapper(x.omp));
      symlinkSync(join(outside, "omp"), join(c.refs, "omp"));
      chmodSync(outside, 0);
      return { reason: `unresolved link ${join(c.refs, "omp")}`, undo: () => chmodSync(outside, 0o700) };
    },
  },
  "B4 a link cycle": {
    arrange: (c) => {
      const outside = outsideDir(c);
      symlinkSync(join(outside, "hop"), join(c.refs, "omp"));
      symlinkSync(join(c.refs, "omp"), join(outside, "hop"));
      return { reason: `unresolved link ${join(c.refs, "omp")}` };
    },
  },
  "B5/P5 a receipt source whose lock is invalid": {
    keepSource: true,
    arrange: (_c, x) => {
      writeFileSync(join(x.source, "native-omp.lock"), "{}");
      return { reason: "unreadable receipt source lock" };
    },
  },
  "P5 a receipt source whose lock cannot be read (EACCES)": {
    keepSource: true,
    arrange: (_c, x) => {
      chmodSync(join(x.source, "native-omp.lock"), 0);
      return {
        reason: "unreadable receipt source lock",
        undo: () => chmodSync(join(x.source, "native-omp.lock"), 0o600),
      };
    },
  },
  "an identity cut by the 1 MiB read window": {
    arrange: (c, x) => {
      writeFileSync(join(c.refs, "ref"), `${" ".repeat(MIB - 32)}${x.identity}`);
      return { reason: `reference ${join(c.refs, "ref")}` };
    },
  },
};

posix.each(Object.keys(CASES))("a prune keeps an identity in use through %s", (name) => {
  const { keepSource, arrange } = CASES[name]!;
  // Permission cases mean nothing to root, which reads through them.
  if (process.getuid?.() === 0 && name.includes("EACCES")) return;
  const c = pruneFixture();
  const x = c.native("x", keepSource);
  const { more = [], reason, undo } = arrange(c, x);
  try {
    const result = c.prune({}, more);
    expect(result.removed).toEqual([]);
    expect(keptFor(result, x.directory)).toContain(reason);
    expect(existsSync(x.omp)).toBe(true);
  } finally {
    undo?.();
  }
});

test("B6 a live process of this user whose working directory cannot be read keeps every identity", async () => {
  if (process.platform !== "linux") return;
  const c = pruneFixture();
  const x = c.native("x");
  // Not dumpable, so its own user cannot read its /proc cwd; it works inside the identity.
  const holder = Bun.spawn(
    [
      "python3",
      "-c",
      "import ctypes,sys; ctypes.CDLL(None).prctl(4,0,0,0,0); print('ready', flush=True); sys.stdin.readline()",
    ],
    { cwd: x.directory, stdin: "pipe", stdout: "pipe" },
  );
  try {
    expect(new TextDecoder().decode((await holder.stdout.getReader().read()).value)).toBe("ready\n");
    const pid = String(holder.pid);
    // The host's other unreadable processes stay out: only this holder is under test.
    const result = c.prune({
      readCwds: (pids) => {
        const read = processCwds(pids);
        return read && { cwds: read.cwds, unreadable: read.unreadable.filter((other) => other === pid) };
      },
    });
    expect(result.removed).toEqual([]);
    expect(
      keptFor(result, x.directory)?.some((why) => why.startsWith(`unreadable working directory of process ${pid}@`)),
    ).toBe(true);
    expect(existsSync(x.omp)).toBe(true);
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

posix.each(["node_modules", ".git"])("a skipped %s subtree holds a prune until explicitly scanned", (name) => {
  const c = pruneFixture();
  const used = c.native("used");
  const free = c.native("free");
  const skipped = join(c.refs, name);
  mkdirSync(join(skipped, ".bin"), { recursive: true });
  symlinkSync(used.omp, join(skipped, ".bin/omp"));
  const hidden = c.prune({ deleteQuarantined: true });
  for (const entry of [used, free]) {
    expect(keptFor(hidden, entry.directory)).toEqual([`unscanned directory ${skipped}`]);
    expect(existsSync(entry.omp)).toBe(true);
  }
  expect(hidden.quarantined).toEqual([]);
  expect(hidden.removed).toEqual([]);
  const scanned = c.prune({}, [skipped]);
  expect(keptFor(scanned, used.directory)).toEqual([`link ${join(skipped, ".bin/omp")}`]);
  expect(scanned.quarantined.map((entry) => entry.directory)).toEqual([free.directory]);
  expect(scanned.removed).toEqual([]);
  expect(existsSync(`${free.directory}.pruning`)).toBe(true);
  const removed = c.prune({ deleteQuarantined: true }, [skipped]);
  expect(removed.removed.map((entry) => entry.directory)).toEqual([free.directory]);
  expect(existsSync(used.omp)).toBe(true);
  expect(existsSync(`${free.directory}.pruning`)).toBe(false);
});
