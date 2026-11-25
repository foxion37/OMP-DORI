// macOS: libproc and sysctl for process facts, the kernel's memory level, POSIX ownership, and a checked terminate.
// The FFI binding opens once per process; every reader throws when the process is gone, so callers keep failing closed.
import { execFileSync } from "node:child_process";
import { constants } from "node:os";
import { posix } from "node:path";
import type { ProcStat } from "../update/proc.ts";
import type { PlatformAdapter, TerminateIdentity } from "./adapter.ts";
import { liveOwnerStart, memoryFreePct, syncDirectory } from "./shared.ts";

type Darwin = {
  readonly pidinfo: (pid: number, flavor: number, size: number) => Uint8Array | undefined;
  readonly pidpath: (pid: number) => string | undefined;
  readonly children: (pid: number) => number[];
  readonly procargs: (pid: number) => Uint8Array | undefined;
  readonly bootSession: () => string | undefined;
};

const PROC_PIDTBSDINFO = 3;
const BSDINFO_SIZE = 136;
const PROC_PIDVNODEPATHINFO = 9;
const VNODEPATHINFO_SIZE = 2352;
const VNODE_INFO_SIZE = 152;
const MAXPATHLEN = 1024;
const SZOMB = 5;
const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;

/**
 * `/usr/sbin/sysctl -n kern.memorystatus_level`: XNU's `memorystatus_level`, the global `memory_pressure` prints as
 * "System-wide memory free percentage". Run by absolute path under a cleared environment with `LC_ALL=C`, within 2 s
 * and 16 bytes, exactly as native/src/discord/darwin.rs reads it for the Rust launch guard.
 */
const sysctlMemoryLevel = (): string =>
  execFileSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level"], {
    encoding: "utf8",
    env: { LC_ALL: "C" },
    maxBuffer: 16,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });

let lib: Darwin | undefined;
function libproc(): Darwin {
  if (lib) return lib;
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    sysctl: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
    sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
  lib = {
    pidinfo: (pid, flavor, size) => {
      const buffer = new Uint8Array(size);
      return symbols.proc_pidinfo(pid, flavor, 0n, ptr(buffer), size) === size ? buffer : undefined;
    },
    pidpath: (pid) => {
      const buffer = new Uint8Array(4 * MAXPATHLEN);
      const length = symbols.proc_pidpath(pid, ptr(buffer), buffer.length);
      return length > 0 ? new TextDecoder().decode(buffer.subarray(0, length)) : undefined;
    },
    children: (pid) => {
      // The count can grow between calls: retry with room to spare until the answer fits.
      for (let room = 64; ; room *= 4) {
        const buffer = new Int32Array(room);
        const count = symbols.proc_listchildpids(pid, ptr(buffer), buffer.byteLength);
        if (count < 0) throw new Error(`process ${pid} children are unavailable`);
        if (count < room) return [...buffer.subarray(0, count)];
      }
    },
    procargs: (pid) => {
      const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
      const size = new BigUint64Array(1);
      if (symbols.sysctl(ptr(mib), mib.length, null, ptr(size), null, 0n) !== 0) return undefined;
      const buffer = new Uint8Array(Number(size[0]));
      if (symbols.sysctl(ptr(mib), mib.length, ptr(buffer), ptr(size), null, 0n) !== 0) return undefined;
      return buffer.subarray(0, Number(size[0]));
    },
    bootSession: () => {
      const name = new TextEncoder().encode("kern.bootsessionuuid\0");
      const buffer = new Uint8Array(64);
      const size = new BigUint64Array([BigInt(buffer.length)]);
      if (symbols.sysctlbyname(ptr(name), ptr(buffer), ptr(size), null, 0n) !== 0) return undefined;
      const end = buffer.indexOf(0);
      return new TextDecoder().decode(buffer.subarray(0, end < 0 ? Number(size[0]) : end));
    },
  };
  return lib;
}

const gone = (pid: number, what: string): Error =>
  Object.assign(new Error(`process ${pid} ${what} is unavailable`), { code: "ENOENT" });

/** libproc's executable path: no /proc link here, so the identity token and the image path are the same answer. */
const executablePath = (pid: number): string => {
  const path = libproc().pidpath(pid);
  if (!path) throw gone(pid, "executable");
  return path;
};

/**
 * The one macOS "memory free %": the kernel's level when it answers a whole percentage, otherwise the free-pages share
 * of physical memory (os.freemem()/os.totalmem(), which macOS answers from free plus speculative pages and hw.memsize),
 * otherwise 0. With neither readable the guard fails closed: both are kernel interfaces every macOS host has, so their
 * absence is a fault to hold launches on, never a reason to admit them. native/src/discord/lanes/guard.rs applies the
 * same policy. The two readers are parameters so it can be pinned without a real sysctl or real free memory.
 */
export const darwinMemFreePct = (
  readLevel: () => string = sysctlMemoryLevel,
  freePct: () => number = memoryFreePct,
): number => {
  try {
    const level = readLevel().trim();
    if (/^\d{1,3}$/.test(level) && Number(level) <= 100) return Number(level);
  } catch {
    // fall through to free pages: a missing sysctl must not stop the guard from reading memory at all
  }
  const fallback = freePct();
  return Number.isFinite(fallback) && fallback >= 0 && fallback <= 100 ? fallback : 0;
};

export const darwin: PlatformAdapter = {
  os: "darwin",

  memFreePct: darwinMemFreePct,

  procStat(pid: number): ProcStat {
    const info = libproc().pidinfo(pid, PROC_PIDTBSDINFO, BSDINFO_SIZE);
    if (!info) throw gone(pid, "status");
    const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
    if (view.getUint32(12, true) !== pid) throw gone(pid, "status");
    const seconds = view.getBigUint64(120, true);
    const micros = view.getBigUint64(128, true);
    return {
      zombie: view.getUint32(4, true) === SZOMB,
      ppid: view.getUint32(16, true),
      pgid: view.getUint32(100, true),
      tpgid: view.getInt32(112, true),
      startTicks: `${seconds}${micros.toString().padStart(6, "0")}`,
    };
  },

  cmdline(pid: number): string {
    const args = libproc().procargs(pid);
    if (!args || args.length < 4) throw gone(pid, "arguments");
    const argc = new DataView(args.buffer, args.byteOffset, args.byteLength).getInt32(0, true);
    // KERN_PROCARGS2: argc, the exec path, NUL padding, then argc NUL-terminated arguments.
    let at = args.indexOf(0, 4);
    if (at < 0) throw gone(pid, "arguments");
    while (at < args.length && args[at] === 0) at++;
    const out: string[] = [];
    for (let index = 0; index < argc; index++) {
      const end = args.indexOf(0, at);
      if (end < 0) throw gone(pid, "arguments");
      out.push(new TextDecoder().decode(args.subarray(at, end)));
      at = end + 1;
    }
    return out.map((arg) => `${arg}\0`).join("");
  },

  exePath: executablePath,
  procExeLink: executablePath,

  cwdPath(pid: number): string {
    const info = libproc().pidinfo(pid, PROC_PIDVNODEPATHINFO, VNODEPATHINFO_SIZE);
    if (!info) throw gone(pid, "working directory");
    const path = info.subarray(VNODE_INFO_SIZE, VNODE_INFO_SIZE + MAXPATHLEN);
    const end = path.indexOf(0);
    if (end <= 0) throw gone(pid, "working directory");
    return new TextDecoder().decode(path.subarray(0, end));
  },

  // One list per process: there is no per-thread split to widen.
  children(pid: number, _everyThread?: boolean): number[] {
    return libproc().children(pid);
  },

  bootId(): string {
    const id = libproc().bootSession();
    if (!id) throw new Error("boot session id is unavailable");
    return id;
  },

  liveOwnerStart,

  // No pidfd here: the caller's identity re-read immediately before kill(2) is today's whole binding, so `stillOurs`
  // is ignored and the caller re-checks identity after any failure.
  terminate(pid: number, _expected?: TerminateIdentity, _stillOurs?: () => boolean): void {
    try {
      process.kill(pid, constants.signals.SIGTERM);
    } catch (error) {
      // A pid that vanished before kill(2) is not ours to signal: its ESRCH reaches the caller, which answers false.
      if ((error as NodeJS.ErrnoException).code === "ESRCH") throw error;
      throw new Error("checked native termination failed");
    }
  },

  supportsProcessReaders: true,
  posixOwnership: true,
  directoryFsync: true,
  // link(2) follows a symlink here; rollback links the pointer's own inode through linkat instead.
  preservesHardLinks: true,
  // No /proc: a zombie has ended, only root can enter another user's directory, and a relative home stays unresolved.
  procfs: false,
  flockLibrary: () => "libSystem.B.dylib",
  syncDirectory,

  supportsHeadlessRelease: (platform, arch) => platform === "darwin" && arch === "arm64",

  nativeCacheLabel: () => `native-darwin-${process.arch}`,
  programName: (word) => word.split("/").at(-1) ?? "",
  windowsExecutableNames: false,
  isAbsolutePath: posix.isAbsolute,
};
