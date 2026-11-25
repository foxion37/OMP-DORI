import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { leaseNativePath } from "../src/release/native.ts";
import { reportNativeCache } from "../src/release/native-cache.ts";
import { leaseNativeIdentity } from "../src/release/native-cache-lease.ts";
import { cachePending } from "../src/release/native-cache-quarantine.ts";
import { useHolds } from "../src/release/native-cache-uses.ts";
import { bootId } from "../src/update/proc.ts";
import { processCwds } from "../src/release/process-cwd.ts";
import { keptFor, processLineReader, pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";
import { script, setup } from "./install-setup.ts";
import { nativeCacheFixture, overlayFixture, ownProcessCwds, ownProcessFiles } from "./source-bundle-setup.ts";

// Astra's review of the first prune commit: original counterexamples run as written, writers that publish an explicit
// cache executable, relative writer commands, a thread group outliving its leader and an empty lock directory.

afterEach(removePruneFixtures);

// POSIX-only: the cache refuses group/world-writable paths, which Windows reports for every file and directory.
const posix = test.skipIf(process.platform === "win32");

posix(
  "an explicit executable in the cache is leased before anything publishes it; one elsewhere leases nothing",
  () => {
    const c = pruneFixture();
    const x = c.native("x");
    const alias = join(c.root, "omp-alias");
    symlinkSync(x.omp, alias);
    leaseNativePath(c.home, alias);
    const leases = join(c.home, ".cache/omp-cataly/native-leases");
    expect(readdirSync(join(leases, x.identity))).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-`))]);
    leaseNativePath(c.home, "/bin/sh");
    expect(readdirSync(leases)).toEqual([x.identity]);
    expect(() => leaseNativePath(c.home, join(x.directory, "bin/missing"))).toThrow("is gone from the native cache");
  },
);

posix("an installer given CATALY_OMP inside the cache holds its lease while it publishes the wrapper", async () => {
  const s = setup();
  const f = overlayFixture(join(s.root, "native-source"), join(s.root, "native-upstream"), `explicit-native ${s.root}`);
  mkdirSync(join(f.source, "scripts"));
  symlinkSync(
    resolve(import.meta.dir, "../scripts/source-dependencies.ts"),
    join(f.source, "scripts/source-dependencies.ts"),
  );
  const x = nativeCacheFixture(f.source, s.home, f.checkout);
  // The installer stops at its first package install, after the lease and before it writes the wrapper.
  const bun = join(s.root, "bin/bun");
  const gate = join(s.root, "gate");
  const stop = `if [ "$1" = install ] && [ ! -e '${gate}' ]; then touch '${gate}'; echo WRITER_GATE; read -r answer; fi\n`;
  writeFileSync(bun, readFileSync(bun, "utf8").replace('case "$1" in', `${stop}case "$1" in`));
  const env = s.env({ CATALY_INSTALL_MODE: "side", CATALY_NO_PULL: "1", CATALY_OMP: x.omp });
  const child = Bun.spawn([script], { cwd: s.root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let stdout = "";
  try {
    while (!stdout.includes("WRITER_GATE")) {
      const read = await reader.read();
      if (read.done) throw new Error(`installer exited early: ${await new Response(child.stderr).text()}`);
      stdout += new TextDecoder().decode(read.value);
    }
    const leases = join(s.home, ".cache/omp-cataly/native-leases", x.identity);
    expect(readdirSync(leases).some((name) => name.startsWith(`${child.pid}-`))).toBe(true);
  } finally {
    child.stdin.write("continue\n");
    child.stdin.end();
    await child.exited;
  }
});

posix("a relative or interpreter-run Cataly writer for this cache keeps every identity", async () => {
  const c = pruneFixture();
  const x = c.native("x");
  // A process whose HOME is the fixture's and whose working directory is the fixture root stands in for the writer.
  const holder = Bun.spawn(["/bin/sh", "-c", "echo ready; read line"], {
    cwd: c.root,
    env: { HOME: c.home, PATH: process.env["PATH"] },
    stdin: "pipe",
    stdout: "pipe",
  });
  try {
    expect(new TextDecoder().decode((await holder.stdout.getReader().read()).value)).toBe("ready\n");
    const uid = process.getuid?.() ?? 0;
    const held = (args: string) =>
      useHolds(join(c.home, ".cache/omp-cataly"), [x.identity], {
        table: () => `${holder.pid} ${uid} ${args}\n`,
        files: ownProcessFiles,
      }).get(x.identity);
    for (const args of [
      `bun scripts/source-dependencies.ts native /old/source ${c.home}`,
      `bun scripts/source-dependencies.ts assert-native /old/source ${relative(c.root, c.home)}`,
      "bun src/release/cli.ts install",
      "bash scripts/install-source.sh",
      "bun skills/cataly-mode/scripts/src/cli.ts update install",
    ])
      expect(held(args)).toEqual([`Cataly cache writer process ${holder.pid} (${args})`]);
    // A writer naming another existing home works on another cache.
    expect(held(`bun scripts/source-dependencies.ts native /old/source ${c.refs}`)).toBeUndefined();
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

test("a lease and a working directory outlive a thread group's leader while its other threads run", async () => {
  if (process.platform !== "linux") return;
  const c = pruneFixture();
  const x = c.native("x");
  // The leader leaves with pthread_exit (a zombie without a working directory); its worker goes on inside the entry.
  const code =
    "import ctypes,sys,threading\ndef work():\n  print('worker', flush=True); sys.stdin.readline()\n" +
    "print('leader', flush=True); sys.stdin.readline(); threading.Thread(target=work).start(); ctypes.CDLL(None).pthread_exit(None)\n";
  const child = Bun.spawn(["python3", "-c", code], { cwd: x.directory, stdin: "pipe", stdout: "pipe" });
  const line = processLineReader(child.stdout);
  try {
    expect(await line()).toBe("leader\n");
    leaseNativeIdentity(c.home, x.identity, child.pid);
    child.stdin.write("go\n");
    child.stdin.flush();
    expect(await line()).toBe("worker\n");
    const pid = String(child.pid);
    // The leader leaves right after starting the worker (a state in /proc, so polled for).
    while (readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z") await Bun.sleep(10);
    expect(processCwds([pid])?.cwds.get(pid)).toBe(x.directory);
    // The real reader, without the host's other unreadable processes.
    const readCwds = (pids: readonly string[]) => {
      const read = processCwds(pids);
      return read && { cwds: read.cwds, unreadable: read.unreadable.filter((other) => other === pid) };
    };
    const result = c.prune({ readCwds });
    expect(result.removed).toEqual([]);
    expect(result.kept[0]?.protectedBy).toEqual(expect.arrayContaining([`lease of process ${pid}`, `process ${pid}`]));
  } finally {
    child.stdin.write("done\n");
    child.stdin.end();
    await child.exited;
  }
});

posix("an empty prune lock directory is not replaced: the prune refuses and removes nothing", () => {
  const c = pruneFixture();
  const x = c.native("x");
  mkdirSync(join(c.home, ".cache/omp-cataly/native-prune.lock"));
  expect(() => c.prune()).toThrow("Another native cache prune holds");
  expect(existsSync(x.omp)).toBe(true);
});

posix(
  "a preparation killed before it cleaned up is removed under the lock, unless its identity is still leased",
  () => {
    // The only live holder created here is this worker's lease; the shell below has exited before any prune.
    const c = pruneFixture(() => ownProcessFiles([String(process.pid)]));
    const x = c.native("x");
    const cache = join(c.home, ".cache/omp-cataly");
    // A preparation whose owner was killed (a pid that has exited), as nativeStagePrefix names it.
    const ended = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]).stdout.toString().trim();
    const stage = join(cache, `native-stage-${x.identity}-${ended}-1-${bootId()}-AbC123`);
    mkdirSync(stage);
    expect(cachePending(c.home)).toEqual([{ directory: stage, identity: x.identity, state: "stage" }]);
    // A live preparation of the identity: its lease keeps both.
    leaseNativeIdentity(c.home, x.identity, process.pid);
    const held = c.prune();
    expect(existsSync(stage)).toBe(true);
    expect(held.removed).toEqual([]);
    rmSync(join(cache, "native-leases"), { recursive: true });
    const freed = c.prune();
    expect(freed.removed.map((removal) => removal.directory)).toEqual([stage]);
    expect(freed.quarantined.map((entry) => entry.directory)).toEqual([x.directory]);
    // One that names no owner (an older writer's) holds every identity and is only listed.
    const older = join(cache, "native-stage-XyZ987");
    mkdirSync(older);
    const y = c.native("y");
    expect(keptFor(c.prune(), y.directory)).toEqual([`native preparation of an older writer ${older}`]);
    expect(cachePending(c.home)).toEqual([{ directory: older, identity: "", state: "older stage" }]);
  },
);

test.each(["file", "directory", "executable"])(
  "a process whose arguments and working directory show no entry but that holds an entry %s keeps the identity",
  async (kind) => {
    if (process.platform !== "linux") return;
    const c = pruneFixture();
    const x = c.native(kind);
    let argv: string[];
    if (kind === "executable") {
      // The entry's own copy of a program, run through a link outside the cache: only /proc/<pid>/exe shows the entry.
      // Named `sleep` throughout, as a multi-call coreutils binary picks its program by that name.
      copyFileSync(realpathSync("/bin/sleep"), join(x.directory, "bin/sleep"));
      mkdirSync(join(c.root, "outside"));
      symlinkSync(join(x.directory, "bin/sleep"), join(c.root, "outside/sleep"));
      argv = [join(c.root, "outside/sleep"), "60"];
    } else {
      // The path comes through the environment, so neither the arguments nor the working directory name it.
      const open =
        kind === "file"
          ? "os.open(os.environ['TARGET'], os.O_RDONLY)"
          : "os.open(os.environ['TARGET'], os.O_RDONLY | os.O_DIRECTORY)";
      argv = ["python3", "-c", `import os,sys; fd=${open}; print('ready', flush=True); sys.stdin.readline()`];
    }
    const target = kind === "file" ? join(x.directory, "receipt.json") : x.directory;
    const holder = Bun.spawn(argv, {
      cwd: c.root,
      env: { PATH: process.env["PATH"], TARGET: target },
      stdin: "pipe",
      stdout: "pipe",
    });
    try {
      if (kind !== "executable") await holder.stdout.getReader().read();
      // The program is running once /proc shows the entry's copy (a state, so polled for).
      else while (!readlinkSync(`/proc/${holder.pid}/exe`).startsWith(x.directory)) await Bun.sleep(10);
      const reason = `process ${holder.pid} has it open, mapped or running`;
      // Still running when the report and the prune look, or the test proves nothing.
      expect(holder.exitCode).toBeNull();
      expect(
        reportNativeCache(c.home, [], [c.refs], ownProcessCwds, { table: () => "", files: ownProcessFiles })[0]
          ?.protectedBy,
      ).toContain(reason);
      const result = c.prune();
      expect(result.quarantined).toEqual([]);
      expect(keptFor(result, x.directory)).toContain(reason);
      expect(existsSync(x.omp)).toBe(true);
      expect(holder.exitCode).toBeNull();
    } finally {
      holder.kill();
      await holder.exited;
    }
  },
);
