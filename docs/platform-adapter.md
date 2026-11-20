# Platform behaviour: one adapter per host

**Every OS-dependent decision the core product makes is named in `src/platform/adapter.ts` and implemented once per OS.** `src/platform/darwin.ts`, `src/platform/linux.ts` and `src/platform/windows.ts` carry today's behaviour without changing it; `src/platform/shared.ts` holds the readers whose code does not vary between hosts. Callers import `platform` from `src/platform/index.ts` instead of testing `process.platform`; the code that still tests the host directly is listed under [Not yet behind the adapter](#not-yet-behind-the-adapter).

## The contract

`PlatformAdapter` in `src/platform/adapter.ts` is the whole surface. One row per member, with what it decides and what each host answers.

| Member | What it decides | darwin | linux | win32 |
| --- | --- | --- | --- | --- |
| `os` | The host this implementation speaks for; it never answers for another OS | `"darwin"` | `"linux"` | `"win32"` |
| `memFreePct()` | Percent of memory available to start new work, as `src/harness.ts` reports it | The kernel's `kern.memorystatus_level` from `sysctl`, rounded; `freemem()/totalmem()` when sysctl fails | `os.freemem()/os.totalmem()`, rounded | Same as Linux |
| `procStat(pid)` | One process's kernel facts (zombie, parent, group, foreground group, start time); darwin's reader throws `process <pid> status is unavailable` and Linux's surfaces `ENOENT` when the process is gone | `libproc` `proc_pidinfo(PROC_PIDTBSDINFO)`; the start time is seconds and microseconds | `/proc/<pid>/stat` | Throws `no process reader for win32` |
| `cmdline(pid)` | The argument vector with every argument NUL-terminated, as the OS cmdline holds it | `libproc` `KERN_PROCARGS2` through `sysctl`, rebuilt from `argc` | `/proc/<pid>/cmdline` | Throws `no process reader for win32` |
| `exePath(pid)` | A path that resolves to the executable image; throws when the process is gone | `libproc` `proc_pidpath` | `/proc/<pid>/exe` | Throws `no process reader for win32` |
| `procExeLink(pid)` | The executable as an identity token, as `procExeTarget` in `src/update/proc.ts` reads it: a replaced image keeps the path it was started from | The same path `exePath` returns | The `/proc/<pid>/exe` link target | Throws `no process reader for win32` |
| `cwdPath(pid)` | A path that resolves to the working directory; throws when the process is gone | `libproc` `proc_pidinfo(PROC_PIDVNODEPATHINFO)` | `/proc/<pid>/cwd` | Throws `no process reader for win32` |
| `children(pid, everyThread?)` | The process's direct children; `everyThread` widens the list where threads can spawn | `proc_listchildpids`; one list per process, so `everyThread` is ignored | Every task's `children` file with `everyThread`, otherwise only the main task's | Throws `no process reader for win32` |
| `bootId()` | One identifier per boot: a pid and start time are comparable only within it | `kern.bootsessionuuid` | `/proc/sys/kernel/random/boot_id` | Throws `no process reader for win32` |
| `liveOwnerStart(pid)` | The lock owner's start time exactly as `ps -o lstart=` prints it, or `""` when `ps` cannot report one; the same `ps` call runs on every host | `ps -o lstart=` | `ps -o lstart=` | `ps -o lstart=` too, but it cannot report one here, so `""` and a lock owner never counts as live |
| `terminate(pid, expected?, stillOurs?)` | SIGTERM one pid through this OS's binding primitive; `stillOurs` is the caller's whole identity check (start time, boot id and executable image), which Linux runs after the pidfd binds and before it signals | `kill(2)`; `stillOurs` is ignored because the caller re-reads identity right before the call; `ESRCH` reaches the caller, any other failure reads `checked native termination failed` | `pidfd_open` and `pidfd_send_signal`, re-checking the `expected` start time and boot id, then `stillOurs`; a mismatch on either reads `native pidfd identity binding failed` | Throws `Linux libc pidfd_open and pidfd_send_signal are required for native replacement` |
| `supportsProcessReaders` | Whether `procStat`, `cmdline`, `exePath`, `cwdPath`, `children` and `bootId` read real kernel facts | `true` | `true` | `false` |
| `posixOwnership` | Whether file ownership is compared by uid, as `src/release/files.ts` `owned()` does | `true` | `true` | `false` |
| `directoryFsync` | Whether a directory can be opened and fsynced; callers only call `syncDirectory`, which does nothing where this is false | `true` | `true` | `false` |
| `preservesHardLinks` | Whether a hard link must keep a symlink's own inode, as `preserveLink` in `src/update/deployment-files.ts` does on rollback | `true`: `linkat` with flags 0, because `link(2)` follows the symlink | `false`: plain `link(2)` links the path itself | `false`, as Linux |
| `supportsHerdrNativeUi` | Whether herdr's native UI path, reading a pane's screen and sending it keys, is open on this host | `false` | `true` | `false` |
| `procfs` | Whether a process's kernel state is readable under `/proc`: its task list (a zombie leader's threads still run), `CapEff`, `environ` and `cwd` | `false`: a zombie has ended, only root can enter another user's directory, a relative home stays unresolved | `true` | `false`, as darwin |
| `flockLibrary()` | The C library `flock(2)` is loaded from, as the native cache lease locks its prune file | `libSystem.B.dylib` | `libc.so.6` | `libc.so.6`, the non-darwin default the lease used |
| `syncDirectory(path)` | Flush a directory's own entries after a rename or link; the only call a caller makes, and a no-op where `directoryFsync` is false | Opens and fsyncs | Opens and fsyncs | No-op |
| `defaultRuntime()` | The runtime a fresh installation selects with none configured | `"hc"` | `"herdr"` | `"herdr"` |
| `supportsReleaseProfile(platform, arch, runtime)` | Whether a release built for that profile is admitted, as `src/release/provision.ts` prerequisites do | `darwin`/`arm64`/`hc` only | `linux`/`x64`/`herdr` only | Never |
| `nativeCacheLabel()` | The native build cache name, `native-<platform>-<arch>` | `native-darwin-<arch>` | `native-linux-<arch>` | `native-win32-<arch>` |
| `programName(word)` | A program word's name: its part after the last separator, on Windows without the `.exe` it runs as | Splits on `/` | Splits on `/` | Splits on `/[\\/]/` and strips a trailing `.exe` |
| `windowsExecutableNames` | Whether a program word may name this host's executable with an `.exe` suffix, as `isOmpExecutable` in `src/runtime/omp-argv.ts` reads `C:\bin\omp.exe` | `false` | `false` | `true` |
| `isAbsolutePath(path)` | `node:path` `isAbsolute` for this adapter's own OS, as `src/update/load.ts` tests an update's `cwd` and `remote` | `posix.isAbsolute` | `posix.isAbsolute` | `win32.isAbsolute` |

## Selecting the adapter

`src/platform/index.ts` chooses once, at import: `const platform` is the running host's adapter, chosen from `process.platform` at module load. Nothing re-reads the host afterwards, so a run cannot switch implementations, and a caller receives the same answers everywhere.

An unrecognised host still imports. It gets a fallback adapter whose process readers throw `no process reader for <platform>` at use, which is where `src/update/proc.ts` threw before, and whose remaining answers are the ones today's code gave an unrecognised POSIX host; Windows is the only host that answers otherwise.

Tests never run on another OS. `adapterFor(os)` returns the implementation for any of the three hosts, `linuxAdapter(root)` points the `/proc` reads at a fixture instead of the kernel, and its optional second argument supplies a fake libc pidfd binding so the identity check before `pidfd_send_signal` is provable off Linux.

## What each OS may and may not assume

- **POSIX ownership is a darwin and linux assumption.** Comparing ownership by uid (`posixOwnership`) and the permission-bit checks built on it run only where the property is true; Windows code must not assume a uid or POSIX modes.
- **Directory fsync is conditional.** Call `syncDirectory` rather than the syscall: on Windows the adapter cannot open a directory for fsync and its implementation does nothing, so no caller repeats the `directoryFsync` test.
- **Per-process kernel state is Linux-only.** Where `procfs` is false, a zombie process has ended, only root can enter an owner-only entry, and a relative home cannot be resolved against the process, so the native cache's use scan holds on all three.
- **The herdr native UI is Linux-only.** `herdrDeploymentCli` in `src/update/deployment-cli.ts` attaches its `nativeUi` read and exit operations only where `supportsHerdrNativeUi` is true, so darwin and win32 deployments have no `nativeUi` key.
- **The default runtime differs.** A fresh installation on darwin selects `hc`; linux and win32 select `herdr`.
- **Only two release profiles are admitted.** `supportsReleaseProfile` accepts `linux`/`x64`/`herdr` and `darwin`/`arm64`/`hc`, and nothing on Windows. A host never admits another host's release.
- **Program names and paths follow the adapter's host.** `programName` strips a Windows `.exe` and splits on either separator, `windowsExecutableNames` says whether that spelling may name OMP, and `isAbsolutePath` answers with the adapter's own `node:path` (`posix` or `win32`), so an injected adapter answers for its OS even on another host.
- **Hard links and executable identity are named too.** `preservesHardLinks` decides whether rollback needs `linkat` to keep a symlink's inode, and `procExeLink` decides whether the identity token is a `/proc` link target or the image path.

## Not yet behind the adapter

These still decide for themselves, and each stays outside for a reason rather than by oversight:

- `skills/dori-mode/scripts/src/**` and `extension/index.ts` are separate packages with their own `process.platform` checks; they do not import the product's platform module.
- `install.sh` runs before the product exists on the host, so it cannot ask an adapter.
- `scripts/verify-consumer-release.ts:29-36` keeps its own runtime and profile policy, and `scripts/` is outside the plan's scope.
- `src/telemetry.ts` and `src/telemetry-otlp.ts` read `node:os` `platform()` directly for metric attributes.
- `src/release/cli.ts:101` still resolves `--home` with `node:path` `isAbsolute` rather than the adapter.
- Five pre-existing deployment modules re-spell the uid ownership test instead of asking `posixOwnership`: `deployment-health.ts`, `deployment-monitor-receipts.ts`, `deployment-monitors.ts`, `deployment-quiesce.ts` and `deployment-toolchain.ts`.

Moving any of them behind this contract is a follow-up.
