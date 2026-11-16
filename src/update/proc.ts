// One process's kernel facts for deployment identity, read the same way on every call. Linux reads /proc exactly as
// before; macOS asks libproc and sysctl for the same facts. Every reader throws when the process is gone or the
// platform has no reader, so callers keep failing closed.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export type ProcStat = {
  readonly zombie: boolean;
  readonly ppid: number;
  readonly pgid: number;
  /** The controlling terminal's foreground process group; 0 or less when there is none. */
  readonly tpgid: number;
  /** Opaque start time: equal for one incarnation, different for a reused PID. */
  readonly startTicks: string;
};

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

let darwinLib: Darwin | undefined;
function darwin(): Darwin {
  if (process.platform !== "darwin") throw new Error(`no process reader for ${process.platform}`);
  if (darwinLib) return darwinLib;
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
  darwinLib = {
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
  return darwinLib;
}

const gone = (pid: number, what: string): Error =>
  Object.assign(new Error(`process ${pid} ${what} is unavailable`), { code: "ENOENT" });

function linuxStatFields(pid: number): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

export function procStat(pid: number): ProcStat {
  if (process.platform === "linux") {
    const fields = linuxStatFields(pid);
    return {
      zombie: fields[0] === "Z",
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      tpgid: Number(fields[5]),
      startTicks: fields[19] ?? "",
    };
  }
  const info = darwin().pidinfo(pid, PROC_PIDTBSDINFO, BSDINFO_SIZE);
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
}

/** The argument vector as Linux's cmdline file holds it: each argument followed by a NUL. */
export function procCmdline(pid: number): string {
  if (process.platform === "linux") return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  const args = darwin().procargs(pid);
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
}

/** A path that opens, stats and resolves to the process's executable image. */
export function procExe(pid: number): string {
  if (process.platform === "linux") return `/proc/${pid}/exe`;
  const path = darwin().pidpath(pid);
  if (!path) throw gone(pid, "executable");
  return path;
}

/** The executable's path as the kernel names it (Linux's exe link target). */
export function procExeTarget(pid: number): string {
  return process.platform === "linux" ? readlinkSync(`/proc/${pid}/exe`) : procExe(pid);
}

/** A path that resolves to the process's working directory. */
export function procCwd(pid: number): string {
  if (process.platform === "linux") return `/proc/${pid}/cwd`;
  const info = darwin().pidinfo(pid, PROC_PIDVNODEPATHINFO, VNODEPATHINFO_SIZE);
  if (!info) throw gone(pid, "working directory");
  const path = info.subarray(VNODE_INFO_SIZE, VNODE_INFO_SIZE + MAXPATHLEN);
  const end = path.indexOf(0);
  if (end <= 0) throw gone(pid, "working directory");
  return new TextDecoder().decode(path.subarray(0, end));
}

/** Direct children: of the main thread, or of every thread (Linux tasks; macOS has one list per process). */
export function procChildren(pid: number, everyThread = false): number[] {
  if (process.platform !== "linux") return darwin().children(pid);
  const tasks = everyThread ? readdirSync(`/proc/${pid}/task`) : [String(pid)];
  return tasks.flatMap((task) =>
    readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number),
  );
}

/** One identifier per boot: a PID and start time are only comparable within it. */
export function bootId(): string {
  if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const id = darwin().bootSession();
  if (!id) throw new Error("boot session id is unavailable");
  return id;
}
