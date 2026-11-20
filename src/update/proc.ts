// One process's kernel facts for deployment identity, read the same way on every call. The readers are the platform
// adapter's (src/platform/darwin.ts reads libproc and sysctl, src/platform/linux.ts reads /proc); every reader throws
// when the process is gone or the host has no reader, so callers keep failing closed.
import { platform } from "../platform/index.ts";

export type ProcStat = {
  readonly zombie: boolean;
  readonly ppid: number;
  readonly pgid: number;
  /** The controlling terminal's foreground process group; 0 or less when there is none. */
  readonly tpgid: number;
  /** Opaque start time: equal for one incarnation, different for a reused PID. */
  readonly startTicks: string;
};

/** Query process existence without sending a signal; permission denial still proves a process exists. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") return true;
    }
    throw error;
  }
}

export function procStat(pid: number): ProcStat {
  return platform.procStat(pid);
}

/** The argument vector as the OS cmdline holds it: each argument followed by a NUL. */
export function procCmdline(pid: number): string {
  return platform.cmdline(pid);
}

/** A path that opens, stats and resolves to the process's executable image. */
export function procExe(pid: number): string {
  return platform.exePath(pid);
}

/** The executable's path as the kernel names it: Linux's exe link target, the image path everywhere else. */
export function procExeTarget(pid: number): string {
  return platform.procExeLink(pid);
}

/** A path that resolves to the process's working directory. */
export function procCwd(pid: number): string {
  return platform.cwdPath(pid);
}

/** Direct children: of the main thread, or of every thread (Linux tasks; macOS has one list per process). */
export function procChildren(pid: number, everyThread = false): number[] {
  return platform.children(pid, everyThread);
}

/** One identifier per boot: a PID and start time are only comparable within it. */
export function bootId(): string {
  return platform.bootId();
}
