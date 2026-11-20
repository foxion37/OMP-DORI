// The platform contract: every OS-dependent decision the product makes is named here and implemented once per OS.
// darwin.ts, linux.ts and windows.ts each carry today's behaviour; index.ts selects one adapter for the running host.
import type { ProcStat } from "../update/proc.ts";

export type HostOs = "darwin" | "linux" | "win32";

/**
 * The incarnation a bound signal may still belong to: the start time and boot id the caller checked. A pidfd binds a
 * process, and only these two facts say whether that process is still the one this caller meant.
 */
export type TerminateIdentity = { readonly startTicks: string; readonly bootId: string };

export interface PlatformAdapter {
  /** The host this implementation speaks for; it never answers for another OS. */
  readonly os: HostOs;

  /**
   * Percent of memory available to start new work, as src/harness.ts reports it: macOS returns the kernel's own
   * available-memory level (kern.memorystatus_level, the figure behind Activity Monitor) and falls back to
   * freemem/totalmem when sysctl fails; every other host rounds os.freemem()/os.totalmem().
   */
  memFreePct(): number;

  /**
   * One process's kernel facts; throws when the process is gone. macOS names the missing reader
   * (`process <pid> status is unavailable`), Linux surfaces the ENOENT its `/proc` read raises.
   */
  procStat(pid: number): ProcStat;

  /** The argument vector with each argument NUL-terminated, as the OS cmdline holds it; throws when unreadable. */
  cmdline(pid: number): string;

  /** A path that opens, stats and resolves to the process's executable image; throws when the process is gone. */
  exePath(pid: number): string;

  /**
   * The executable's path as an identity token, as src/update/proc.ts procExeTarget reads it: Linux's `/proc/<pid>/exe`
   * link target, which keeps the old path of a replaced image, and elsewhere exactly what exePath returns.
   */
  procExeLink(pid: number): string;

  /** A path that resolves to the process's working directory; throws when the process is gone. */
  cwdPath(pid: number): string;

  /**
   * Direct children of the process. Linux reads /proc/<pid>/task: with everyThread it concatenates every task's child
   * list (threads can spawn), without it only the main task's. macOS has one list per process and ignores the flag.
   */
  children(pid: number, everyThread?: boolean): number[];

  /** One identifier per boot: a PID and start time are only comparable within it; throws when unavailable. */
  bootId(): string;

  /**
   * The lock owner's start time exactly as `ps -o lstart=` prints it, in the reader's zone, or "" when ps cannot
   * report one (today's "not a live owner" answer). src/update/state.ts parses it with Date.parse and compares.
   */
  liveOwnerStart(pid: number): string;

  /**
   * SIGTERM one pid through this OS's binding primitive. Linux opens a pidfd and signals through it, refusing with
   * `native pidfd identity binding failed` when the supplied `expected` incarnation no longer matches; between that
   * open and the signal it also calls `stillOurs`, the caller's whole identity check (start time, boot id and the
   * executable image), refusing on false so a process that re-execs into another image is not signalled. macOS has no
   * pidfd and sends kill(2), rethrowing its ESRCH error so src/update/deployment-signal.ts maps `code === "ESRCH"` to
   * false instead of treating a vanished pid as one it signalled; it ignores `stillOurs` and leaves that check to the
   * caller. Every other failure carries the messages src/update/deployment-signal.ts printed; process-identity
   * comparison stays with the caller, which re-checks it after a failure.
   */
  terminate(pid: number, expected?: TerminateIdentity, stillOurs?: () => boolean): void;

  /** True when procStat, cmdline, exePath, cwdPath, children and bootId read real kernel facts (Windows: false). */
  readonly supportsProcessReaders: boolean;

  /** True when file ownership is compared by uid, as src/release/files.ts owned() does (Windows: false). */
  readonly posixOwnership: boolean;

  /** True when a directory can be opened and fsynced; Windows answers false and its syncDirectory no-ops. */
  readonly directoryFsync: boolean;

  /**
   * True where a hard link must be made without following a symlink, as src/update/deployment-files.ts preserves an
   * installation pointer's inode on rollback. macOS links through `linkat` with flags 0; elsewhere `link(2)` already
   * links the path itself.
   */
  readonly preservesHardLinks: boolean;

  /**
   * True when herdr's native UI path — reading a pane's screen and sending it keys — is open on this host. It is
   * Linux-only today: herdr serves `pane read` and `pane send-keys` there, and src/update/deployment-cli.ts attaches
   * `nativeUi` only where this is true.
   */
  readonly supportsHerdrNativeUi: boolean;

  /**
   * True when a process's kernel state is readable under `/proc`: its task list (a zombie leader's threads still run),
   * `CapEff`, `environ` and `cwd`. src/release/native-cache-lease.ts asks before a zombie counts as ended, and
   * native-cache-uses.ts before it reads capabilities or resolves a home. Where false, a zombie has ended, only root
   * can enter an owner-only entry, and a relative home cannot be resolved against the process.
   */
  readonly procfs: boolean;

  /** The C library `flock(2)` is loaded from, as src/release/native-cache-lease.ts locks the prune file. */
  flockLibrary(): string;

  /** Flush a directory's own entries after a rename or link; a no-op where directoryFsync is false. */
  syncDirectory(path: string): void;

  /** The runtime a fresh installation selects with none configured: hc on macOS, herdr elsewhere. */
  defaultRuntime(): "herdr" | "hc";

  /**
   * Whether this host admits a release built for `platform`, `arch` and `runtime`, exactly as
   * src/release/provision.ts prerequisites do: linux/x64/herdr or darwin/arm64/hc, never another host's profile.
   */
  supportsReleaseProfile(platform: string, arch: string, runtime: string): boolean;

  /** The native build cache name, `native-<platform>-<arch>`, as src/release/native.ts builds it. */
  nativeCacheLabel(): string;

  /** A program word's name: its part after the last separator, on Windows without the `.exe` it runs as. */
  programName(word: string): string;

  /**
   * True where a program word may name this host's executable with a Windows executable suffix, as
   * src/runtime/omp-argv.ts reads an OMP launch line (`C:\bin\omp.exe`). Only Windows answers true.
   */
  readonly windowsExecutableNames: boolean;

  /** `node:path` isAbsolute for this OS, as src/update/load.ts tests an update's `cwd` and `remote`. */
  isAbsolutePath(path: string): boolean;
}
