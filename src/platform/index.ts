// The one selection point: the host is read once at import, and every caller asks this module instead of re-testing
// process.platform. An unrecognised host still imports; its process readers throw at use, where proc.ts already threw.
import { posix } from "node:path";
import type { HostOs, PlatformAdapter } from "./adapter.ts";
import { darwin } from "./darwin.ts";
import { linux } from "./linux.ts";
import { liveOwnerStart, memoryFreePct, syncDirectory } from "./shared.ts";
import { windows } from "./windows.ts";

const adapters: Record<HostOs, PlatformAdapter> = { darwin, linux, win32: windows };

/** The adapter for one host: what tests inject instead of running on that OS. */
export function adapterFor(os: HostOs): PlatformAdapter {
  return adapters[os];
}

/**
 * Whether `/proc` carries `os`'s process facts, as that host's adapter answers; a host with no implementation has
 * none. src/release/process-cwd.ts and process-files.ts take a host for tests and ask here instead of re-testing one.
 */
export function procfsOn(os: string): boolean {
  return adapters[os as HostOs]?.procfs === true;
}

/**
 * A host with no implementation: readers throw `no process reader for <platform>`, which is what src/update/proc.ts
 * threw when called there, so the failure lands at the call site rather than at import. The remaining answers are the
 * ones today's code gave an unrecognised POSIX host; Windows is the only host that reports otherwise.
 */
function unsupported(os: string): PlatformAdapter {
  const noReader = (): never => {
    throw new Error(`no process reader for ${os}`);
  };
  return {
    os: os as HostOs,
    memFreePct: memoryFreePct,
    procStat: noReader,
    cmdline: noReader,
    exePath: noReader,
    procExeLink: noReader,
    cwdPath: noReader,
    children: noReader,
    bootId: noReader,
    liveOwnerStart,
    terminate: () => {
      throw new Error("Linux libc pidfd_open and pidfd_send_signal are required for native replacement");
    },
    supportsProcessReaders: false,
    posixOwnership: process.getuid !== undefined,
    directoryFsync: true,
    preservesHardLinks: false,
    supportsHerdrNativeUi: false,
    procfs: false,
    flockLibrary: () => "libc.so.6",
    syncDirectory,
    defaultRuntime: () => "herdr",
    supportsReleaseProfile: () => false,
    nativeCacheLabel: () => `native-${os}-${process.arch}`,
    programName: (word) => word.split("/").at(-1) ?? "",
    windowsExecutableNames: false,
    isAbsolutePath: posix.isAbsolute,
  };
}

/** The host this process runs on, chosen once: nothing re-reads process.platform after import. */
export const platform: PlatformAdapter =
  process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
    ? adapters[process.platform]
    : unsupported(process.platform);
