import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shq } from "../src/delivery.ts";
import { processStart } from "../src/release/process-cwd.ts";
import { processFiles } from "../src/release/process-files.ts";
import { bootId } from "../src/update/proc.ts";
import { keptFor, processLineReader, pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";

afterEach(removePruneFixtures);

// POSIX-only: the cache refuses group/world-writable paths, which Windows reports for every file and directory.
const posix = test.skipIf(process.platform === "win32");

// A thread group whose leader exited still runs: what its other threads hold open or mapped keeps the entry (Astra,
// 35e104e). The program opens or maps a file whose path comes through the environment, from a working directory
// outside the cache, then its main thread leaves.
const THREAD = `import ctypes, mmap, os, sys, threading
fd = os.open(os.environ["TARGET"], os.O_RDONLY)
if os.environ["HOLD"] == "map":
  kept = mmap.mmap(fd, 0, prot=mmap.PROT_READ)
  os.close(fd)
def work():
  print("worker", flush=True)
  sys.stdin.readline()
threading.Thread(target=work).start()
ctypes.CDLL(None).pthread_exit(None)
`;
const threadHolder = async (cwd: string, target: string, hold: "open" | "map") => {
  const child = Bun.spawn(["python3", "-c", THREAD], {
    cwd,
    env: { PATH: process.env["PATH"], TARGET: target, HOLD: hold },
    stdin: "pipe",
    stdout: "pipe",
  });
  expect(await processLineReader(child.stdout)()).toBe("worker\n");
  // The leader is a zombie once it has left (a state in /proc, so polled for).
  while (readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z") await Bun.sleep(10);
  return child;
};

test.each(["open", "map"] as const)(
  "Astra (35e104e): a file an exited leader's thread keeps %s keeps the identity",
  async (hold) => {
    if (process.platform !== "linux") return;
    const c = pruneFixture();
    const x = c.native(hold);
    const child = await threadHolder(c.root, join(x.directory, "receipt.json"), hold);
    try {
      const result = c.prune();
      expect(result.quarantined).toEqual([]);
      expect(existsSync(x.omp)).toBe(true);
    } finally {
      child.stdin.end();
      await child.exited;
    }
  },
);

test("Astra (35e104e): a dead owner's stage stays while an exited leader's thread keeps a file in it open", async () => {
  if (process.platform !== "linux") return;
  const c = pruneFixture();
  const x = c.native("x");
  const ended = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]).stdout.toString().trim();
  const stage = join(c.home, ".cache/omp-dori", `native-stage-${x.identity}-${ended}-1-${bootId()}-AbC123`);
  mkdirSync(stage);
  writeFileSync(join(stage, "still-needed"), "payload");
  const child = await threadHolder(c.root, join(stage, "still-needed"), "open");
  try {
    c.prune();
    expect(existsSync(join(stage, "still-needed"))).toBe(true);
  } finally {
    child.stdin.end();
    await child.exited;
  }
});

posix(
  "a live process whose open files cannot be read keeps every identity, even when its working directory is read",
  () => {
    const c = pruneFixture();
    const x = c.native("x");
    const files = () => ({ files: new Map<string, string[]>(), unread: [String(process.pid)] });
    // This test process's own working directory is readable; only its files are reported unreadable here.
    const held = c.prune({ files });
    expect(keptFor(held, x.directory)?.[0]).toStartWith(`unreadable open files of process ${process.pid}@`);
    expect(c.prune({ files, trust: [`${process.pid}@${processStart(String(process.pid))}`] }).quarantined).toHaveLength(
      1,
    );
  },
);

// Astra (9bf008e): a stage is removed at once, so a descriptor opened after an earlier stage's check must still be
// seen. Two killed owners' stages; a process opens a file in the one left once the other is gone.
posix("a dead owner's stage is checked against processes' files read afresh, not an earlier stage's look", () => {
  const c = pruneFixture();
  const ended = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]).stdout.toString().trim();
  const stages = ["a", "b"].map((name) => {
    const x = c.native(name);
    const stage = join(c.home, ".cache/omp-dori", `native-stage-${x.identity}-${ended}-1-${bootId()}-AbC123`);
    mkdirSync(stage);
    writeFileSync(join(stage, "still-needed"), "payload");
    return stage;
  });
  const files = () => {
    const left = stages.filter(existsSync);
    const open = left.length < stages.length ? left.map((stage) => join(stage, "still-needed")) : [];
    return { files: new Map([[String(process.pid), open]]), unread: [] };
  };
  c.prune({ files });
  expect(stages.filter(existsSync)).toHaveLength(1);
});

posix("process files are read the macOS way through lsof, and are unavailable where lsof is missing", async () => {
  const c = pruneFixture();
  const x = c.native("x");
  const target = join(x.directory, "receipt.json");
  const code =
    "import os,sys; fd=os.open(os.environ['TARGET'], os.O_RDONLY); print('ready', flush=True); sys.stdin.readline()";
  const holder = Bun.spawn(["python3", "-c", code], {
    cwd: c.root,
    env: { PATH: process.env["PATH"], TARGET: target },
    stdin: "pipe",
    stdout: "pipe",
  });
  try {
    expect(new TextDecoder().decode((await holder.stdout.getReader().read()).value)).toBe("ready\n");
    const read = processFiles("darwin");
    if (!Bun.which("lsof")) return expect(read).toBeNull();
    expect(read?.files.get(String(holder.pid))).toContain(realpathSync(target));
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

posix.each([0, 1])("a lsof listing with exit %i keeps uncertainty conservative", (status) => {
  const c = pruneFixture();
  const x = c.native("lsof");
  const bin = join(c.root, "bin");
  mkdirSync(bin);
  const listed = status === 0 ? x.omp : join(c.root, "unrelated-file");
  writeFileSync(
    join(bin, "lsof"),
    `#!/bin/sh\nprintf '%s\\n' ${shq(`p${process.pid}`)} ${shq(`n${listed}`)}\nexit ${status}\n`,
    { mode: 0o700 },
  );
  const code = `const { processFiles } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/release/process-files.ts"))});
const read = processFiles("darwin");
console.log(JSON.stringify(read && { files: [...read.files], unread: read.unread }));`;
  const child = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe("");
  const snapshot = JSON.parse(child.stdout.toString()) as { files: [string, string[]][]; unread: string[] } | null;
  const read = snapshot && { files: new Map(snapshot.files), unread: snapshot.unread };
  if (status === 0) expect(read?.files.get(String(process.pid))).toEqual([x.omp]);
  else expect(read).toBeNull();
  const pruned = c.prune({ files: () => read });
  expect(pruned.removed).toEqual([]);
  expect(pruned.quarantined).toEqual([]);
  expect(keptFor(pruned, x.directory)).toContain(
    status === 0 ? `process ${process.pid} has it open, mapped or running` : "open files of processes unavailable",
  );
  expect(existsSync(x.omp)).toBe(true);
});

const kernel =
  process.platform === "linux"
    ? readdirSync("/proc").find((pid) => {
        if (!/^\d+$/.test(pid)) return false;
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const flags = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[6];
          return flags !== undefined && (BigInt(flags) & 0x0020_0000n) !== 0n;
        } catch {
          return false;
        }
      })
    : undefined;

test.skipIf(!kernel)("confirmed kernel threads do not become unreadable user file or cwd holds", () => {
  const code = `const { processFiles } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/release/process-files.ts"))});
const { processCwds, processIsKernelThread } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/release/process-cwd.ts"))});
const kernel = ${JSON.stringify(kernel)};
// Child-only UID selection admits both the actual kernel thread and this user process; credentials stay unchanged.
process.getuid = undefined;
const files = processFiles("linux");
const cwd = processCwds([String(process.pid), kernel], "linux");
console.log(JSON.stringify({
  ownFiles: files?.files.has(String(process.pid)) === true,
  ownCwd: cwd?.cwds.has(String(process.pid)) === true,
  kernelFiles: files?.files.has(kernel) === true,
  kernelFilesUnread: files?.unread.includes(kernel) === true,
  kernelCwd: cwd?.cwds.has(kernel) === true,
  kernelCwdUnread: cwd?.unreadable.includes(kernel) === true,
  kernelFlag: processIsKernelThread(kernel),
  userFlag: processIsKernelThread(String(process.pid)),
  unknownFlags: processIsKernelThread("0") === undefined
}));`;
  const child = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe("");
  expect(JSON.parse(child.stdout.toString())).toEqual({
    ownFiles: true,
    ownCwd: true,
    kernelFiles: false,
    kernelFilesUnread: false,
    kernelCwd: false,
    kernelCwdUnread: false,
    kernelFlag: true,
    userFlag: false,
    unknownFlags: true,
  });
});
