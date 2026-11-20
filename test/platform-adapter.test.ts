// The contract's proof: every host's capability matrix as the product reads it, with the host injected instead of
// run. The running host's own readers get one smoke test, so moving them into src/platform/ cannot go silent.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { herdrDeploymentCli } from "../src/update/deployment-cli.ts";
import type { HostOs } from "../src/platform/adapter.ts";
import { darwinMemFreePct } from "../src/platform/darwin.ts";
import { adapterFor, platform } from "../src/platform/index.ts";
import { linuxAdapter } from "../src/platform/linux.ts";
import { memoryFreePct } from "../src/platform/shared.ts";

/** A /proc fixture: one pid with its stat and two task child lists, plus the boot id a signal identity names. */
function fixtureProc(startTicks: string): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "platform-proc-"));
  mkdirSync(join(root, "4242", "task", "4242"), { recursive: true });
  mkdirSync(join(root, "4242", "task", "4243"), { recursive: true });
  mkdirSync(join(root, "sys/kernel/random"), { recursive: true });
  // state, ppid, pgid, then padding up to the start time at index 19; further fields trail it as a real stat does.
  const fields = [
    "S",
    "1",
    "4242",
    ...Array.from({ length: 16 }, () => "0"),
    startTicks,
    ...Array.from({ length: 32 }, () => "0"),
  ];
  writeFileSync(join(root, "4242", "stat"), `4242 (bun) ${fields.join(" ")}\n`);
  writeFileSync(join(root, "4242", "task", "4242", "children"), "7 8\n");
  writeFileSync(join(root, "4242", "task", "4243", "children"), "9\n");
  writeFileSync(join(root, "sys/kernel/random/boot_id"), "boot-1\n");
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("platform adapter contract", () => {
  test("the adapter is the one chosen for this process's platform", () => {
    expect<HostOs>(platform.os).toBe(process.platform as HostOs);
    expect(adapterFor(platform.os)).toBe(platform);
  });
});

describe("capability matrix", () => {
  test("Windows has no POSIX ownership", () => {
    expect(adapterFor("win32").posixOwnership).toBe(false);
  });

  test("macOS defaults to the hc runtime", () => {
    expect(adapterFor("darwin").defaultRuntime()).toBe("hc");
  });

  test("Linux defaults to the herdr runtime", () => {
    expect(adapterFor("linux").defaultRuntime()).toBe("herdr");
  });

  test("Windows strips .exe from a program word", () => {
    expect(adapterFor("win32").programName("C:\\a\\bun.exe")).toBe("bun");
  });

  test("Linux does not split a program word on backslashes", () => {
    expect(adapterFor("linux").programName("C:\\a\\bun.exe")).toBe("C:\\a\\bun.exe");
  });

  test("only Windows lacks process readers, and its readers say so", () => {
    expect(adapterFor("darwin").supportsProcessReaders).toBe(true);
    expect(adapterFor("linux").supportsProcessReaders).toBe(true);
    expect(adapterFor("win32").supportsProcessReaders).toBe(false);
    expect(() => adapterFor("win32").procStat(1)).toThrow("no process reader for win32");
    expect(() => adapterFor("win32").bootId()).toThrow("no process reader for win32");
  });

  test("only Windows skips the directory flush", () => {
    expect(adapterFor("win32").directoryFsync).toBe(false);
    expect(() => adapterFor("win32").syncDirectory("/tmp")).not.toThrow();
    expect(adapterFor("darwin").directoryFsync).toBe(true);
    expect(adapterFor("linux").directoryFsync).toBe(true);
  });

  test("release profiles are the ones provision.ts admitted", () => {
    expect(adapterFor("darwin").supportsReleaseProfile("darwin", "arm64", "hc")).toBe(true);
    expect(adapterFor("darwin").supportsReleaseProfile("linux", "x64", "herdr")).toBe(false);
    expect(adapterFor("linux").supportsReleaseProfile("linux", "x64", "herdr")).toBe(true);
    expect(adapterFor("linux").supportsReleaseProfile("linux", "arm64", "herdr")).toBe(false);
    expect(adapterFor("win32").supportsReleaseProfile("linux", "x64", "herdr")).toBe(false);
  });

  test("the native cache label keeps the native-<platform>-<arch> shape", () => {
    for (const os of ["darwin", "linux", "win32"] as const)
      expect(adapterFor(os).nativeCacheLabel()).toBe(`native-${os}-${process.arch}`);
  });

  test("only Linux opens the herdr native UI", () => {
    expect(adapterFor("linux").supportsHerdrNativeUi).toBe(true);
    expect(adapterFor("darwin").supportsHerdrNativeUi).toBe(false);
    expect(adapterFor("win32").supportsHerdrNativeUi).toBe(false);
  });

  test("only Linux reads a process's kernel state through /proc", () => {
    expect(adapterFor("linux").procfs).toBe(true);
    expect(adapterFor("darwin").procfs).toBe(false);
    expect(adapterFor("win32").procfs).toBe(false);
  });

  test("only macOS preserves an installation pointer's inode through linkat", () => {
    expect(adapterFor("darwin").preservesHardLinks).toBe(true);
    expect(adapterFor("linux").preservesHardLinks).toBe(false);
    expect(adapterFor("win32").preservesHardLinks).toBe(false);
  });

  test("only Windows reads a launch word spelled with an .exe suffix", () => {
    expect(adapterFor("win32").windowsExecutableNames).toBe(true);
    expect(adapterFor("darwin").windowsExecutableNames).toBe(false);
    expect(adapterFor("linux").windowsExecutableNames).toBe(false);
  });

  test("a Linux exe link target is the identity token; the other hosts answer with the image path", () => {
    const proc = fixtureProc("777");
    try {
      const adapter = linuxAdapter(proc.root);
      symlinkSync(process.execPath, join(proc.root, "4242", "exe"));
      expect(adapter.exePath(4242)).toBe(join(proc.root, "4242", "exe"));
      expect(adapter.procExeLink(4242)).toBe(process.execPath);
    } finally {
      proc.done();
    }
    // No /proc link here: the identity token is the image path libproc reports.
    expect(adapterFor("darwin").procExeLink).toBe(adapterFor("darwin").exePath);
    expect(() => adapterFor("win32").procExeLink(1)).toThrow("no process reader for win32");
  });

  test("the lock's C library follows the host, as the lease loaded it before the adapter", () => {
    expect(adapterFor("darwin").flockLibrary()).toBe("libSystem.B.dylib");
    expect(adapterFor("linux").flockLibrary()).toBe("libc.so.6");
    expect(adapterFor("win32").flockLibrary()).toBe("libc.so.6");
  });

  test("the herdr deployment CLI carries nativeUi exactly where the host admits it", () => {
    const cli = herdrDeploymentCli(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect("nativeUi" in cli).toBe({ darwin: false, linux: true, win32: false }[platform.os]);
  });

  test("the every-thread flag reaches the Linux task walk", () => {
    const proc = fixtureProc("777");
    try {
      const adapter = linuxAdapter(proc.root);
      expect(adapter.children(4242).sort()).toEqual([7, 8]);
      expect(adapter.children(4242, true).sort()).toEqual([7, 8, 9]);
    } finally {
      proc.done();
    }
  });

  test("a Linux signal refuses an incarnation that no longer matches", () => {
    const proc = fixtureProc("777");
    try {
      const adapter = linuxAdapter(proc.root);
      expect(() => adapter.terminate(4242, { startTicks: "111", bootId: "boot-1" })).toThrow(
        "native pidfd identity binding failed",
      );
      expect(() => adapter.terminate(4242, { startTicks: "777", bootId: "other-boot" })).toThrow(
        "native pidfd identity binding failed",
      );
    } finally {
      proc.done();
    }
  });

  test("a Linux signal refires the caller's identity check after binding and before signalling", () => {
    const proc = fixtureProc("777");
    try {
      const signalled: number[] = [];
      const closed: number[] = [];
      let unloaded = 0;
      const adapter = linuxAdapter(proc.root, () => ({
        pidfd: {
          open: () => 3,
          signal: (_fd: number, signal: number) => {
            signalled.push(signal);
            return 0;
          },
          close: (fd: number) => {
            closed.push(fd);
          },
        },
        unload: () => {
          unloaded++;
        },
      }));
      // A target that re-execs into another image keeps the pid and start time; only the caller's whole check refuses it.
      expect(() => adapter.terminate(4242, { startTicks: "777", bootId: "boot-1" }, () => false)).toThrow(
        "native pidfd identity binding failed",
      );
      expect(signalled).toEqual([]);
      expect(closed).toEqual([3]);
      expect(unloaded).toBe(1);

      adapter.terminate(4242, { startTicks: "777", bootId: "boot-1" }, () => true);
      expect(signalled).toEqual([constants.signals.SIGTERM]);
      expect(closed).toEqual([3, 3]);
    } finally {
      proc.done();
    }
  });

  test("macOS reads the kernel's memory level and falls back to free pages", () => {
    expect(adapterFor("darwin").memFreePct).toBe(darwinMemFreePct);
    // Only macOS consults sysctl: the other hosts never spawn it, they round the shared free-page ratio.
    expect(adapterFor("linux").memFreePct).toBe(memoryFreePct);
    expect(adapterFor("win32").memFreePct).toBe(memoryFreePct);
    const free = () => 3;
    expect(darwinMemFreePct(() => "72\n", free)).toBe(72);
    expect(
      darwinMemFreePct(() => {
        throw new Error("no sysctl");
      }, free),
    ).toBe(3);
    expect(darwinMemFreePct(() => "garbage", free)).toBe(3);
  });

  test("absolute paths follow the adapter's own OS, not the running host", () => {
    expect(adapterFor("linux").isAbsolutePath("/a")).toBe(true);
    expect(adapterFor("linux").isAbsolutePath("C:\\a")).toBe(false);
    expect(adapterFor("darwin").isAbsolutePath("/a")).toBe(true);
    expect(adapterFor("win32").isAbsolutePath("C:\\a")).toBe(true);
  });
});

test.skipIf(!platform.supportsProcessReaders)("this host's process readers answer for a live process", () => {
  expect(platform.procStat(process.pid).ppid).toBeGreaterThan(0);
  expect(platform.bootId()).not.toBe("");
  expect(platform.cmdline(process.pid)).toContain("\0");
  expect(platform.exePath(process.pid)).not.toBe("");
  expect(platform.cwdPath(process.pid)).not.toBe("");
  expect(platform.liveOwnerStart(process.pid)).not.toBe("");
  expect(platform.memFreePct()).toBeGreaterThanOrEqual(0);
});
