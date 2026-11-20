// Windows: no process readers, no POSIX ownership and no directory fsync. Each reader throws the message the shared
// reader threw on this host before, so callers fail closed instead of reading another OS's facts.
import { win32 } from "node:path";
import type { ProcStat } from "../update/proc.ts";
import type { PlatformAdapter, TerminateIdentity } from "./adapter.ts";
import { liveOwnerStart, memoryFreePct } from "./shared.ts";

const noReader = (): never => {
  throw new Error("no process reader for win32");
};

export const windows: PlatformAdapter = {
  os: "win32",

  // os.freemem()/os.totalmem() is the only memory figure Windows exposes here, as the host reader always answered.
  memFreePct: memoryFreePct,

  procStat(_pid: number): ProcStat {
    return noReader();
  },

  cmdline(_pid: number): string {
    return noReader();
  },

  exePath(_pid: number): string {
    return noReader();
  },

  procExeLink(_pid: number): string {
    return noReader();
  },

  cwdPath(_pid: number): string {
    return noReader();
  },

  children(_pid: number, _everyThread?: boolean): number[] {
    return noReader();
  },

  bootId(): string {
    return noReader();
  },

  // ps cannot report a start time here, so this is "" and the lock owner never counts as live; today's answer.
  liveOwnerStart,

  terminate(_pid: number, _expected?: TerminateIdentity, _stillOurs?: () => boolean): void {
    // The non-macOS branch reached libc pidfd on this host too and failed with exactly this message.
    throw new Error("Linux libc pidfd_open and pidfd_send_signal are required for native replacement");
  },

  supportsProcessReaders: false,
  posixOwnership: false,
  directoryFsync: false,
  preservesHardLinks: false,
  supportsHerdrNativeUi: false,
  procfs: false,
  // Nothing takes a prune lock here, so this is the non-darwin default the lease loaded before the adapter.
  flockLibrary: () => "libc.so.6",

  syncDirectory(_path: string): void {
    // Windows cannot open a directory for fsync; src/update/deployment-files.ts skipped the flush here.
  },

  defaultRuntime: () => "herdr",

  // No release is built for Windows: provision.ts admitted only linux/x64/herdr and darwin/arm64/hc.
  supportsReleaseProfile: () => false,

  nativeCacheLabel: () => `native-win32-${process.arch}`,
  programName: (word) => (word.split(/[\\/]/).at(-1) ?? "").replace(/\.exe$/i, ""),
  windowsExecutableNames: true,
  isAbsolutePath: win32.isAbsolute,
};
