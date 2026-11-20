import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { claimNativePrune, leaseNativeIdentity, scriptLeaseHolder } from "../src/release/native-cache-lease.ts";
import { processCwds, processStart } from "../src/release/process-cwd.ts";
import { bootId } from "../src/update/proc.ts";
import { inspectRuntimeToolchain } from "../src/update/deployment-toolchain.ts";
import { keptFor, pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";
import { preparationFixture } from "./update-deploy-prepare-setup.ts";

// The shared lease every writer takes and the prune lock: who waits for whom, and how long a lease lasts.

afterEach(removePruneFixtures);

// POSIX-only: the cache refuses group/world-writable paths, which Windows reports for every file and directory.
const posix = test.skipIf(process.platform === "win32");

const LEASE = resolve(import.meta.dir, "../src/release/native-cache-lease.ts");
const DEPENDENCIES = resolve(import.meta.dir, "../scripts/source-dependencies.ts");
const ready = async (child: { stdout: ReadableStream<Uint8Array> }) =>
  new TextDecoder().decode((await child.stdout.getReader().read()).value);

posix("a writer leases first and waits while a prune holds the lock, then goes on", async () => {
  const c = pruneFixture();
  const x = c.native("x");
  const release = claimNativePrune(c.home);
  const code = `const { leaseNativeIdentity } = await import(${JSON.stringify(LEASE)}); leaseNativeIdentity(process.argv[1], process.argv[2]); console.log(Date.now());`;
  const writer = Bun.spawn([process.execPath, "-e", code, c.home, x.identity], { stdout: "pipe", stderr: "pipe" });
  const leases = join(c.home, ".cache/omp-dori/native-leases", x.identity);
  let released = 0;
  try {
    // Its lease appears for the prune to see before it reads the lock (a file, so polled for).
    while (!(existsSync(leases) && readdirSync(leases).length)) await Bun.sleep(10);
    expect(readdirSync(leases)).toEqual([`${writer.pid}-${processStart(String(writer.pid))}-${bootId()}`]);
  } finally {
    released = Date.now();
    release();
  }
  expect(await writer.exited).toBe(0);
  // It went on only once the prune released the lock.
  expect(Number(await new Response(writer.stdout).text())).toBeGreaterThanOrEqual(released);
});

test("the cache launcher's lease lasts as long as the shell that execs OMP, and ends with it", async () => {
  if (process.platform !== "linux") return;
  const c = pruneFixture();
  const x = c.native("x", true);
  // As the launcher does: verify through source-dependencies as a child of the shell, then exec in place.
  const shell = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      `"$0" "$1" assert-native "$2" "$3" >/dev/null && echo ready && exec sleep 60`,
      process.execPath,
      DEPENDENCIES,
      x.source,
      c.home,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    expect(await ready(shell)).toBe("ready\n");
    // The checkout moves on; nothing but the running session's lease uses the identity now.
    rmSync(x.source, { recursive: true });
    const held = c.prune();
    expect(keptFor(held, x.directory)).toEqual([`lease of process ${shell.pid}`]);
  } finally {
    shell.kill();
    await shell.exited;
  }
  expect(c.prune().quarantined.map((entry) => entry.directory)).toEqual([x.directory]);
});

test("a script's lease holder is the named shell, else its parent", () => {
  expect(scriptLeaseHolder({ DORI_NATIVE_LEASE_PID: "4242" })).toBe(4242);
  expect(() => scriptLeaseHolder({ DORI_NATIVE_LEASE_PID: "4242; rm" })).toThrow("must be a process id");
  expect(scriptLeaseHolder({})).toBe(process.ppid > 1 ? process.ppid : process.pid);
});

posix(
  "the prune lock is a kernel lock: held while its holder runs, free once it ends, refused if not a file",
  async () => {
    const c = pruneFixture();
    const x = c.native("x");
    const lock = join(c.home, ".cache/omp-dori/native-prune.lock");
    const code = `const { claimNativePrune } = await import(${JSON.stringify(LEASE)}); claimNativePrune(process.argv[1]); console.log("held"); await Bun.stdin.text();`;
    const holder = Bun.spawn([process.execPath, "-e", code, c.home], { stdin: "pipe", stdout: "pipe" });
    try {
      expect(await ready(holder)).toBe("held\n");
      expect(() => c.prune()).toThrow(`Another native cache prune holds ${lock}`);
      expect(() => leaseNativeIdentity(c.home, x.identity, process.pid, 0)).toThrow("A native cache prune holds");
    } finally {
      // Killed, not released: the kernel lets go of its lock all the same.
      holder.kill("SIGKILL");
      await holder.exited;
    }
    // The next prune runs, and sees the lease the waiting writer took.
    expect(keptFor(c.prune(), x.directory)).toEqual([`lease of process ${process.pid}`]);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock);
    mkdirSync(lock);
    expect(() => c.prune()).toThrow(`Another native cache prune holds ${lock}`);
  },
);

test("--trust-process lets one unreadable process pass only while it is still that process", async () => {
  if (process.platform !== "linux") return;
  const c = pruneFixture();
  const x = c.native("x");
  const holder = Bun.spawn(
    [
      "python3",
      "-c",
      "import ctypes,sys; ctypes.CDLL(None).prctl(4,0,0,0,0); print('ready', flush=True); sys.stdin.readline()",
    ],
    { cwd: c.root, stdin: "pipe", stdout: "pipe" },
  );
  try {
    expect(await ready(holder)).toBe("ready\n");
    const pid = String(holder.pid);
    const token = `${pid}@${processStart(pid)}`;
    const readCwds = (pids: readonly string[]) => {
      const read = processCwds(pids);
      return read && { cwds: read.cwds, unreadable: read.unreadable.filter((other) => other === pid) };
    };
    const held = c.prune({ readCwds });
    expect(keptFor(held, x.directory)?.[0]).toStartWith(`unreadable working directory of process ${token} (python3`);
    // The token of a pid that now names another process (another start) trusts nothing.
    const reused = c.prune({ readCwds, trust: [`${pid}@1`] });
    expect(reused.trusted).toEqual([{ process: `${pid}@1`, trusted: false }]);
    expect(reused.removed).toEqual([]);
    expect(() => c.prune({ readCwds, trust: [pid] })).toThrow("--trust-process takes PID@START");
    const trusted = c.prune({ readCwds, trust: [token] });
    expect(trusted.trusted).toEqual([{ process: token, trusted: true }]);
    expect(trusted.quarantined.map((entry) => entry.directory)).toEqual([x.directory]);
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

test("a root process whose working directory cannot be read holds unless --trust-root-cwd, which counts it", () => {
  const init = existsSync("/proc/1/status") ? readFileSync("/proc/1/status", "utf8") : "";
  if (process.platform !== "linux" || process.getuid?.() === 0 || !/^Uid:\s+0\s/m.test(init)) return;
  const c = pruneFixture();
  const x = c.native("x");
  // Only pid 1 (root's init) is in the table, so the host's other processes stay out.
  const table = () => "1 0 /sbin/init\n";
  const readCwds = (pids: readonly string[]) => {
    const read = processCwds(pids);
    return read && { cwds: read.cwds, unreadable: read.unreadable.filter((pid) => pid === "1") };
  };
  const held = c.prune({ table, readCwds });
  expect(keptFor(held, x.directory)).toEqual([
    "unreadable working directories of 1 root or privileged processes (see --trust-root-cwd)",
  ]);
  const trusted = c.prune({ table, readCwds, trustRootCwd: true });
  expect(trusted.rootCwdTrusted).toBe(1);
  expect(trusted.quarantined.map((entry) => entry.directory)).toEqual([x.directory]);
});

posix("direct legacy inspection leases its identity before executable or fence verification", async () => {
  const c = pruneFixture();
  const x = c.native("legacy");
  const f = preparationFixture();
  await expect(
    inspectRuntimeToolchain({ ...f.config, home: c.home }, f.record, join(x.directory, "bin/missing"), true),
  ).rejects.toThrow("is gone from the native cache");
  const leases = join(c.home, ".cache/omp-dori/native-leases", x.identity);
  expect(readdirSync(leases).some((name) => name.startsWith(`${process.pid}-`))).toBe(true);
  expect(existsSync(join(f.config.releaseRoot, "native-config.json"))).toBe(false);
  expect(keptFor(c.prune(), x.directory)).toEqual([`lease of process ${process.pid}`]);
});

posix("a FIFO prune lock is refused by both prunes and writers without blocking", () => {
  const c = pruneFixture();
  const x = c.native("fifo");
  const lock = join(c.home, ".cache/omp-dori/native-prune.lock");
  const made = Bun.spawnSync(["python3", "-c", "import os,sys; os.mkfifo(sys.argv[1])", lock]);
  expect(made.exitCode).toBe(0);
  expect(() => c.prune()).toThrow("Another native cache prune holds");
  expect(() => leaseNativeIdentity(c.home, x.identity, process.pid, 0)).toThrow("A native cache prune holds");
  expect(existsSync(x.omp)).toBe(true);
});
