import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { snapshot } from "../scripts/consumer-smoke-inspect.ts";
import { reportNativeCache } from "../src/release/native-cache.ts";
import { processCwds } from "../src/release/process-cwd.ts";
import { nativeCacheFixture, overlayFixture, ownProcessCwds, ownProcessFiles } from "./source-bundle-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// POSIX-only: the cache refuses group/world-writable paths, which Windows reports for every file and directory.
const posix = test.skipIf(process.platform === "win32");

function cache() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-native-cache-")));
  roots.push(root);
  const home = join(root, "home");
  const native = (name: string, source = join(root, `source-${name}`)) => {
    const f = overlayFixture(source, join(root, `upstream-${name}`), `${name} ${root}`);
    return { source: f.source, receipt: nativeCacheFixture(f.source, home, f.checkout) };
  };
  return { root, home, native };
}

posix("the report names what uses each identity and removes none, the unused one included", async () => {
  const c = cache();
  const live = c.native("live");
  const releases = join(c.root, "cataly/releases");
  const discovered = c.native("discovered", join(releases, "retained-release"));
  const wrapped = c.native("wrapped");
  const running = c.native("running");
  const superseded = c.native("superseded");
  for (const source of [wrapped.source, running.source, superseded.source]) rmSync(source, { recursive: true });
  mkdirSync(join(c.root, "cataly/bin"), { recursive: true });
  writeFileSync(join(c.root, "cataly/bin/omp"), `#!/bin/sh\nexec ${wrapped.receipt.omp} "$@"\n`);
  const unknown = join(c.home, ".cache/omp-cataly", `native-${process.platform}-${process.arch}-${"e".repeat(64)}`);
  mkdirSync(unknown, { mode: 0o700 });
  const holder = Bun.spawn(["/bin/sh", "-c", "echo ready; read line", "cataly-native-holder", running.receipt.omp], {
    stdin: "pipe",
    stdout: "pipe",
  });
  try {
    // The holder has exec'd once it speaks, so its argv is the one the process table shows.
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    const sources = [live.source];
    const scanned = [join(c.root, "cataly")];
    const entries = reportNativeCache(c.home, sources, scanned, ownProcessCwds, { files: ownProcessFiles });
    const reasons = Object.fromEntries(entries.map((entry) => [entry.directory, entry.protectedBy]));
    expect(reasons[live.receipt.directory]).toEqual(
      expect.arrayContaining([`source ${live.source}`, "receipt source"]),
    );
    expect(reasons[discovered.receipt.directory]).toContain(`source ${discovered.source}`);
    expect(reasons[wrapped.receipt.directory]).toEqual([`reference ${join(c.root, "cataly/bin/omp")}`]);
    // Only processes keep it, the holder among them (another process may work in that directory too).
    expect(reasons[running.receipt.directory]).toContain(`process ${holder.pid}`);
    expect(reasons[running.receipt.directory]?.every((reason) => reason.startsWith("process "))).toBe(true);
    expect(reasons[superseded.receipt.directory]).toEqual([]);
    expect(reasons[unknown]).toEqual(["unrecognized receipt"]);
    expect(entries.find((entry) => entry.directory === superseded.receipt.directory)!.bytes).toBeGreaterThan(0);
    for (const kept of [live, discovered, wrapped, running, superseded])
      expect(existsSync(kept.receipt.omp)).toBe(true);
    expect(existsSync(unknown)).toBe(true);
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

posix("a link into the cache, a process working in an entry and a partial receipt are reported as uses", async () => {
  const c = cache();
  const linked = c.native("linked");
  const chained = c.native("chained");
  const partial = c.native("partial");
  const worked = c.native("worked");
  const free = c.native("free");
  for (const f of [linked, chained, partial, worked, free]) rmSync(f.source, { recursive: true });
  const bin = join(c.root, "cataly/bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(linked.receipt.omp, join(bin, "omp"));
  // A chain whose first link names nothing in the cache still resolves into it.
  symlinkSync(chained.receipt.omp, join(c.root, "hop"));
  symlinkSync(join(c.root, "hop"), join(bin, "omp-side"));
  const { identity, source } = partial.receipt;
  writeFileSync(join(partial.receipt.directory, "receipt.json"), JSON.stringify({ identity, source }));
  // A process works inside one entry without naming it in its arguments.
  const holder = Bun.spawn(["/bin/sh", "-c", "echo ready; read line"], {
    cwd: worked.receipt.directory,
    stdin: "pipe",
    stdout: "pipe",
  });
  try {
    expect(new TextDecoder().decode((await holder.stdout.getReader().read()).value)).toBe("ready\n");
    const entries = reportNativeCache(c.home, [], [join(c.root, "cataly")], ownProcessCwds, { files: ownProcessFiles });
    const reasons = Object.fromEntries(entries.map((entry) => [entry.directory, entry.protectedBy]));
    expect(reasons[linked.receipt.directory]).toEqual([`link ${join(bin, "omp")}`]);
    expect(reasons[chained.receipt.directory]).toEqual([`link ${join(bin, "omp-side")}`]);
    expect(reasons[partial.receipt.directory]).toEqual(["unrecognized receipt"]);
    expect(reasons[worked.receipt.directory]).toContain(`process ${holder.pid}`);
    expect(reasons[free.receipt.directory]).toEqual([]);
    for (const kept of [linked, chained, partial, worked, free]) expect(existsSync(kept.receipt.directory)).toBe(true);
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

posix(
  "a link to a wrapper outside the roots reports what it names; a link to an unscanned directory every identity",
  () => {
    const c = cache();
    const wrapped = c.native("wrapped");
    const free = c.native("free");
    for (const f of [wrapped, free]) rmSync(f.source, { recursive: true });
    const outside = join(c.root, "opt/wrappers");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "omp"), `#!/bin/sh\nexec ${wrapped.receipt.omp} "$@"\n`);
    const refs = join(c.root, "refs");
    mkdirSync(refs);
    symlinkSync(join(outside, "omp"), join(refs, "omp"));
    const report = (roots: string[]) =>
      Object.fromEntries(
        // This fixture checks references, not consumer commands in sibling tests.
        reportNativeCache(c.home, [], roots, ownProcessCwds, { table: () => "", files: ownProcessFiles }).map(
          (entry) => [entry.directory, entry.protectedBy],
        ),
      );
    const linked = report([refs]);
    expect(linked[wrapped.receipt.directory]).toEqual([`reference ${join(refs, "omp")}`]);
    expect(linked[free.receipt.directory]).toEqual([]);
    symlinkSync(outside, join(refs, "wrappers"));
    const held = `link to an unscanned directory ${join(refs, "wrappers")}`;
    expect(report([refs])[free.receipt.directory]).toEqual([held]);
    // Once that directory is scanned too, its link no longer holds anything.
    expect(report([refs, join(c.root, "opt")])[free.receipt.directory]).toEqual([]);
    // A reference root given as a link is read at its real path.
    symlinkSync(outside, join(c.root, "wrappers-alias"));
    expect(report([join(c.root, "wrappers-alias")])[wrapped.receipt.directory]).toEqual([
      `reference ${join(outside, "omp")}`,
    ]);
    expect(existsSync(free.receipt.directory)).toBe(true);
  },
);

posix.each(["linux", "darwin"] as const)("a process's working directory is read the %s way", async (platform) => {
  if (platform === "linux" && process.platform !== "linux") return;
  const c = cache();
  const holder = Bun.spawn(["/bin/sh", "-c", "echo ready; read line"], { cwd: c.root, stdin: "pipe", stdout: "pipe" });
  try {
    expect(new TextDecoder().decode((await holder.stdout.getReader().read()).value)).toBe("ready\n");
    const read = processCwds([String(holder.pid)], platform);
    // A Linux host without lsof (as macOS always has it) cannot read the macOS way: unavailable, never empty.
    if (platform === "darwin" && !Bun.which("lsof")) return expect(read).toBeNull();
    expect(read?.cwds.get(String(holder.pid))).toBe(realpathSync(c.root));
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

posix("cataly update cache reports by default; --prune quarantines, trusting only the processes it is told to", () => {
  const c = cache();
  const superseded = c.native("superseded");
  renameSync(superseded.source, join(c.root, "moved-away"));
  const cli = resolve(import.meta.dir, "../src/release/cli.ts");
  const run = (...argv: string[]) =>
    Bun.spawnSync([process.execPath, cli, "cache", ...argv], {
      env: { HOME: c.home, PATH: process.env["PATH"], OMP_CATALY_HOME: join(c.root, "side") },
    });
  const cacheRoot = join(c.home, ".cache/omp-cataly");
  const before = snapshot(cacheRoot);
  const listed = run();
  expect(listed.exitCode).toBe(0);
  const report = JSON.parse(listed.stdout.toString());
  expect(report).toMatchObject({ removes: "nothing", pending: [] });
  expect(report.entries).toEqual([expect.objectContaining({ directory: superseded.receipt.directory })]);
  // On a real host only unreadable processes (this user's, listed to trust one by one; privileged ones) hold it.
  const host = /^unreadable (?:working directory of process |open files of process |working directories of \d+ root)/;
  expect(report.entries[0].protectedBy.filter((reason: string) => !host.test(reason))).toEqual([]);
  expect(existsSync(superseded.receipt.directory)).toBe(true);
  expect(snapshot(cacheRoot)).toBe(before);
  expect(run("--from", c.root).exitCode).toBe(2);
  expect(run("--trust-root-cwd").stderr.toString()).toContain("apply to cache --prune");
  expect(run("--delete-quarantined").stderr.toString()).toContain("apply to cache --prune");
  expect(run("--prune", "--grace", "soon").stderr.toString()).toContain("--grace takes whole minutes");
  const trust = report.trustable.flatMap((token: string) => ["--trust-process", token]);
  const pruned = run("--prune", "--trust-root-cwd", ...trust);
  expect(pruned.exitCode).toBe(0);
  const result = JSON.parse(pruned.stdout.toString());
  // Root's processes come and go between the two runs, but there are some exactly when the report listed some.
  expect(result.rootCwdTrusted > 0).toBe(report.privileged.length > 0);
  // Another lane's launch or a process that started after the report may still hold it; nothing else may.
  const late =
    /^(?:Cataly cache writer process |unreadable (?:working directory|open files) of process |lease of process )/;
  const kept = result.kept.flatMap((entry: { protectedBy: string[] }) => entry.protectedBy);
  expect(kept.filter((reason: string) => !late.test(reason))).toEqual([]);
  // Unused, it is only moved aside: removal requires an explicitly asked later prune after the grace period.
  expect(result.removed).toEqual([]);
  expect(result.quarantined.length).toBe(kept.length > 0 ? 0 : 1);
  expect(existsSync(`${superseded.receipt.directory}.pruning`)).toBe(kept.length === 0);
  expect(JSON.parse(run().stdout.toString()).pending.map((entry: { state: string }) => entry.state)).toEqual(
    kept.length > 0 ? [] : ["quarantined"],
  );
});
