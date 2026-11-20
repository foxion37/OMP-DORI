import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pruneNativeCache } from "../src/release/native-cache-prune.ts";
import type { NativeReceipt } from "../src/release/native.ts";
import { bootId } from "../src/update/proc.ts";
import { type PruneFixture, pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";
import { ownProcessCwds, ownProcessFiles } from "./source-bundle-setup.ts";

// Reviewers' counterexamples against the first prune that removed in one run (Astra B7 and its third-scan and new-root
// variants, Fable P6, prune-concurrency, process-after-ps), a killed preparation's surviving child and a killed lock
// holder. An older writer takes no lease, so what it publishes during any look must still keep its identity.

afterEach(removePruneFixtures);

// POSIX-only: the cache refuses group/world-writable paths, which Windows reports for every file and directory.
const posix = test.skipIf(process.platform === "win32");

const GRACE = 600_000;
type Late = { readonly scan: number; readonly publish: (c: PruneFixture, x: NativeReceipt) => void };
const wrapper = (c: PruneFixture, x: NativeReceipt) => writeFileSync(join(c.refs, "omp"), c.wrapper(x.omp));
const LATE: Record<string, Late> = {
  "Astra B7: a reference after the second scan": { scan: 2, publish: wrapper },
  "Astra R1-A: a reference after the third scan": { scan: 3, publish: wrapper },
  "Astra R1-B: a reference root that did not exist, made at the second scan": {
    scan: 2,
    publish: (c, x) => {
      mkdirSync(c.refs, { recursive: true });
      wrapper(c, x);
    },
  },
  "Fable P6: a reference while the live name is made again": {
    scan: 2,
    publish: (c, x) => {
      wrapper(c, x);
      mkdirSync(x.directory);
    },
  },
  "prune-concurrency: a reference beside a second prune, which is refused": {
    scan: 2,
    publish: (c, x) => {
      wrapper(c, x);
      const module = resolve(import.meta.dir, "../src/release/native-cache-prune.ts");
      const code = `const { pruneNativeCache } = await import(${JSON.stringify(module)}); pruneNativeCache(process.argv[1], [], [process.argv[2]], { table: () => "", graceMs: 0 });`;
      expect(Bun.spawnSync([process.execPath, "-e", code, c.home, c.refs]).exitCode).not.toBe(0);
    },
  },
};

posix.each(Object.keys(LATE))("%s keeps the identity: it is put back before its grace period ends", (name) => {
  const { scan, publish } = LATE[name]!;
  const c = pruneFixture();
  const x = c.native("x");
  if (name.includes("did not exist")) rmSync(c.refs, { recursive: true });
  // The reviewers' scan numbers count from the quarantining prune's one scan: scan 2 is the first scan that finds the
  // copy quarantined (the live entries of the next prune), scan 3 the second (its look at the quarantined copies). They
  // are counted by that state, not by calls, which differ between platforms.
  let quarantinedScans = 0;
  const readCwds = (pids: readonly string[]) => {
    if (existsSync(`${x.directory}.pruning`) && ++quarantinedScans === scan - 1) publish(c, x);
    return ownProcessCwds(pids);
  };
  const runs = [0, GRACE / 2, 2 * GRACE].map((now) => c.prune({ readCwds, graceMs: GRACE, now }));
  expect(runs.flatMap((run) => run.removed)).toEqual([]);
  expect(existsSync(name.includes("made again") ? `${x.directory}.pruning/bin/omp` : x.omp)).toBe(true);
});

posix("Astra process-after-ps: a shell that enters a quarantined copy keeps it, and puts it back", async () => {
  const c = pruneFixture();
  const x = c.native("x");
  c.prune({ graceMs: GRACE, now: 0 });
  const holder = Bun.spawn(["/bin/sh", "-c", "read line"], { cwd: `${x.directory}.pruning`, stdin: "pipe" });
  try {
    const later = c.prune({ graceMs: GRACE, now: GRACE });
    expect(later.removed).toEqual([]);
    expect(existsSync(x.omp)).toBe(true);
  } finally {
    holder.kill();
    await holder.exited;
  }
});

test("Astra R2: a preparation whose owner was killed stays while its detached child works in it", async () => {
  if (process.platform !== "linux") return;
  const c = pruneFixture();
  const x = c.native("x");
  const childFile = join(c.root, "child.pid");
  const lease = resolve(import.meta.dir, "../src/release/native-cache-lease.ts");
  const run = resolve(import.meta.dir, "../src/update/deployment-process.ts");
  // As provisionNativeSource does: lease, make the stage, run a detached command in it.
  const code = `import { mkdtempSync } from "node:fs"; import { join } from "node:path";
import { leaseNativeIdentity, nativeStagePrefix } from ${JSON.stringify(lease)}; import { command } from ${JSON.stringify(run)};
const [home, identity, pidfile] = process.argv.slice(1); leaseNativeIdentity(home, identity);
const stage = mkdtempSync(join(home, ".cache/omp-dori", nativeStagePrefix(identity))); console.log(stage);
await command(["/bin/sh", "-c", 'echo $$ > "$1"; exec sleep 60', "stage-child", pidfile], stage, { PATH: process.env.PATH, HOME: home }, 60000);`;
  const owner = Bun.spawn([process.execPath, "-e", code, c.home, x.identity, childFile], { stdout: "pipe" });
  let child = 0;
  try {
    const stage = new TextDecoder().decode((await owner.stdout.getReader().read()).value).trim();
    // The child writes its pid once it runs (a file, so polled for).
    while (!existsSync(childFile) || !readFileSync(childFile, "utf8").trim()) await Bun.sleep(10);
    child = Number(readFileSync(childFile, "utf8").trim());
    owner.kill("SIGKILL");
    await owner.exited;
    // Its lease ended with it; the child, in the stage, did not.
    const result = c.prune();
    expect(existsSync(stage)).toBe(true);
    expect(readlinkSync(`/proc/${child}/cwd`)).toBe(stage);
    expect(result.kept.find((entry) => entry.directory === stage)?.protectedBy).toContain(`process ${child}`);
  } finally {
    owner.kill();
    await owner.exited;
    if (child) process.kill(child, "SIGKILL");
  }
});

posix("Astra R3: a lock a killed recoverer left mid-takeover (lock and tombstone one file) never blocks prunes", () => {
  const c = pruneFixture();
  const x = c.native("x");
  // The state the reviewer built: an ended holder's lock, already hard-linked to its tombstone, not yet unlinked.
  const lock = join(c.home, ".cache/omp-dori/native-prune.lock");
  const ended = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]).stdout.toString().trim();
  writeFileSync(lock, JSON.stringify({ pid: Number(ended), startTicks: "1", bootId: bootId() }));
  linkSync(lock, `${lock}.ended-${ended}-1-${bootId()}`);
  const runs = [0, 1].map(() =>
    pruneNativeCache(c.home, [], [c.refs], {
      readCwds: ownProcessCwds,
      files: ownProcessFiles,
      table: () => "",
      graceMs: 0,
      deleteQuarantined: true,
    }),
  );
  expect(runs.at(-1)!.removed.map((removal) => removal.directory)).toEqual([x.directory]);
});

test.each(["file", "directory"])(
  "Astra R2 (cfbfb77): a killed owner's stage stays while a process outside it holds a %s descriptor in it",
  async (kind) => {
    if (process.platform !== "linux") return;
    const c = pruneFixture();
    const x = c.native(kind);
    const ended = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]).stdout.toString().trim();
    const stage = join(c.home, ".cache/omp-dori", `native-stage-${x.identity}-${ended}-1-${bootId()}-AbC123`);
    mkdirSync(stage);
    writeFileSync(join(stage, "still-needed"), "payload");
    // As the reviewer ran it: the holder works outside the stage and only keeps a descriptor open.
    const target = kind === "file" ? join(stage, "still-needed") : stage;
    const code =
      "import os,sys; fd=os.open(os.environ['TARGET'],os.O_RDONLY); print(fd,flush=True); sys.stdin.readline()";
    const holder = Bun.spawn(["python3", "-c", code], {
      cwd: c.root,
      env: { PATH: process.env["PATH"], TARGET: target },
      stdin: "pipe",
      stdout: "pipe",
    });
    try {
      const fd = new TextDecoder().decode((await holder.stdout.getReader().read()).value).trim();
      expect(readlinkSync(`/proc/${holder.pid}/fd/${fd}`)).toBe(target);
      const result = c.prune();
      expect(existsSync(join(stage, "still-needed"))).toBe(true);
      expect(result.kept.find((entry) => entry.directory === stage)?.protectedBy).toContain(
        `process ${holder.pid} has a file open in it`,
      );
    } finally {
      holder.stdin.end();
      await holder.exited;
    }
  },
);

// Owner decision (R1): an older writer's absence cannot be proven, so no prune removes anything unless asked.
posix("Astra R1 (cfbfb77): a reference after the third scan, two prunes past the grace period, removes nothing", () => {
  const c = pruneFixture();
  const x = c.native("x");
  let scans = 0;
  // The reviewer's run: publish at the third process scan; prunes at now and now + 600001 with the default grace.
  const readCwds = (pids: readonly string[]) => {
    if (++scans === 3) wrapper(c, x);
    return ownProcessCwds(pids);
  };
  const runs = [0, 600_001].map((now) => c.prune({ readCwds, graceMs: GRACE, now }));
  expect(runs.flatMap((run) => run.removed)).toEqual([]);
  expect(existsSync(x.omp) || existsSync(`${x.directory}.pruning/bin/omp`)).toBe(true);
});

posix("without --delete-quarantined nothing is removed after any grace period; with it only unused copies go", () => {
  // This private cache has only wrapper references from this worker; the test starts no live holder process.
  const c = pruneFixture(() => ownProcessFiles([String(process.pid)]));
  const unused = c.native("unused");
  const used = c.native("used");
  c.prune({ graceMs: GRACE, now: 0 });
  expect(c.prune({ graceMs: GRACE, now: 100 * GRACE }).removed).toEqual([]);
  wrapper(c, used);
  const asked = c.prune({ graceMs: GRACE, now: 100 * GRACE, deleteQuarantined: true });
  expect(asked.removed.map((removal) => removal.directory)).toEqual([unused.directory]);
  expect(existsSync(used.omp)).toBe(true);
  // Before its grace period ends a copy stays even when removal is asked.
  const fresh = c.native("fresh");
  c.prune({ graceMs: GRACE, now: 0 });
  expect(c.prune({ graceMs: GRACE, now: GRACE - 1, deleteQuarantined: true }).removed).toEqual([]);
  expect(existsSync(`${fresh.directory}.pruning/bin/omp`)).toBe(true);
});

posix(
  "a use that appears after the asked prune's look is seen at its check before removal and puts the copy back",
  () => {
    const c = pruneFixture();
    const x = c.native("x");
    c.prune({ graceMs: GRACE, now: 0 });
    let scans = 0;
    // Scan 1 is the live entries, 2 the quarantined copies (its walk already done), 3 the check of `.deleting-<nonce>`.
    const readCwds = (pids: readonly string[]) => {
      if (++scans === 2) wrapper(c, x);
      return ownProcessCwds(pids);
    };
    const asked = c.prune({ readCwds, graceMs: GRACE, now: GRACE, deleteQuarantined: true });
    expect(scans).toBe(3);
    expect(asked.removed).toEqual([]);
    expect(asked.kept.find((entry) => entry.directory === x.directory)?.protectedBy).toEqual(
      expect.arrayContaining([`reference ${join(c.refs, "omp")}`, "kept at the check before removal"]),
    );
    expect(existsSync(x.omp)).toBe(true);
  },
);
