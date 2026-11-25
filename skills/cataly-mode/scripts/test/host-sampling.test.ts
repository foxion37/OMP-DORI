import { expect, test } from "bun:test";
import { platform } from "../../../../src/platform/index.ts";
import { sampleHost } from "../src/host-guard.ts";
import { canLaunch } from "../src/routing.ts";
import { ChosenRuntimes, type Runner, run } from "../src/run.ts";
import { FakeHeadless } from "./fake-headless.ts";
import { newWorld } from "./fakes.ts";

const loadavg = "0.50 0.40 0.30 1/200 999\n";
const meminfo = "MemTotal: 16000000 kB\nMemAvailable: 4000000 kB\n";
const fixture = (
  platform: NodeJS.Platform,
  options: {
    mac?: boolean;
    sessionFailure?: boolean;
    memory?: string | null;
    load?: string | null;
    darwinMemory?: number;
  } = {},
) => {
  const calls: string[][] = [],
    reads: string[] = [];
  let memoryReads = 0;
  const runner: Runner = async (argv) => {
    calls.push([...argv]);
    const key = argv.join(" ");
    let out: string;
    if (key === "sysctl -n vm.loadavg" && options.mac) out = "{ 1.25 0.5 0.2 }";
    else if (key === "memory_pressure -Q" && options.mac) out = "System-wide memory free percentage: 42%";
    else if (key === "sysctl -n vm.swapusage" && options.mac) out = "total = 4096.00M used = 2048.00M free = 2048.00M";
    else if (key === "cat /proc/loadavg") out = loadavg.trim();
    else if (key === "cat /proc/meminfo") out = meminfo.trim();
    else if (argv[0] === "df") out = "Filesystem 1K-blocks Used Available Use% Mounted\n/dev/x 1000 500 524288 50% /";
    else return { code: 127, out: "", err: "unavailable" };
    return { code: 0, out, err: "" };
  };
  const world = newWorld();
  const supervisor = new (class extends FakeHeadless {
    override async list() {
      if (options.sessionFailure) throw new Error("headless supervisor unavailable");
      return super.list();
    }
  })(world, "/state");
  const rts = new ChosenRuntimes(
    () => ({ kind: "headless", source: "default" }),
    () => supervisor,
  );
  const result = sampleHost(runner, "/data path", rts, {
    platform,
    // The platform adapter's macOS reader, injected so no host runs a real sysctl here.
    memFreePct: () => {
      memoryReads++;
      return options.darwinMemory ?? 42;
    },
    readFile: (path) => {
      reads.push(path);
      const value =
        path === "/proc/loadavg"
          ? options.load === undefined
            ? loadavg
            : options.load
          : path === "/proc/meminfo"
            ? options.memory === undefined
              ? meminfo
              : options.memory
            : null;
      if (value === null) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      return value;
    },
  });
  return { result, calls, reads, world, rts, memoryReads: () => memoryReads };
};

test("Linux reads proc directly, only spawns df and counts sessions through the headless supervisor", async () => {
  const f = fixture("linux");
  expect(await f.result).toEqual({
    load1: 0.5,
    memFreePct: 25,
    diskFreeGb: 0.5,
    swapFreeGb: 0,
    panes: 0,
    cgroup: { version: null, hard: null, high: null, incomplete: true },
  });
  expect(f.reads).toEqual(["/proc/loadavg", "/proc/meminfo", "/proc/self/cgroup", "/proc/self/mountinfo"]);
  expect(f.calls).toEqual([["df", "-k", "/data path"]]);
  expect(f.world.calls).toEqual([["headless", "list", ""]]);
  expect(f.memoryReads()).toBe(0);
});

test.each([null, "MemTotal: 16000000 kB\n", "MemTotal: 0 kB\nMemAvailable: 0 kB\n", "invalid"])(
  "unavailable or malformed Linux memory keeps the existing 100 percent fallback: %s",
  async (memory) => {
    const f = fixture("linux", { memory, load: null });
    const s = await f.result;
    expect(s.memFreePct).toBe(100);
    expect(s.load1).toBe(0);
    expect(f.calls).toHaveLength(1);
  },
);

test("zero Linux MemAvailable stays zero, not the unknown fallback", async () => {
  const f = fixture("linux", { memory: "MemTotal: 1000 kB\nMemAvailable: 0 kB\n" });
  expect((await f.result).memFreePct).toBe(0);
});

test("a failed session list still holds admission rather than claiming zero sessions", async () => {
  const f = fixture("linux", { sessionFailure: true });
  const s = await f.result;
  expect(s.panes).toBe(-1);
  expect(
    canLaunch(s, { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 0, panesMax: 20 }).reasons,
  ).toEqual(["session count unknown"]);
});

test("darwin takes memory from the platform adapter and keeps the sysctl load, df and swap probes", async () => {
  const f = fixture("darwin", { mac: true });
  expect(await f.result).toEqual({ load1: 1.25, memFreePct: 42, diskFreeGb: 0.5, swapFreeGb: 2, panes: 0 });
  expect(f.reads).toEqual([]);
  expect(f.memoryReads()).toBe(1);
  expect(f.calls.map((argv) => argv[0])).toEqual(["sysctl", "df", "sysctl"]);
});

test("darwin samples the adapter's fail-closed 0 when no memory reader answers, never a /proc fallback", async () => {
  const f = fixture("darwin", { darwinMemory: 0 });
  const s = await f.result;
  expect(s.memFreePct).toBe(0);
  expect(
    canLaunch(s, { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 0, panesMax: 20 }).reasons,
  ).toEqual(["memory free 0% < 20%"]);
  expect(f.calls.map((argv) => argv[0])).toEqual(["sysctl", "cat", "df", "sysctl"]);
  expect(f.calls).not.toContainEqual(["cat", "/proc/meminfo"]);
});

test("another non-Linux host keeps the legacy runner probes and never asks memory_pressure", async () => {
  const f = fixture("freebsd", { mac: true });
  expect(await f.result).toEqual({ load1: 1.25, memFreePct: 25, diskFreeGb: 0.5, swapFreeGb: 2, panes: 0 });
  expect(f.memoryReads()).toBe(0);
  expect(f.calls.map((argv) => argv[0])).toEqual(["sysctl", "cat", "df", "sysctl"]);
});

test("non-Linux probe failures retain the legacy runner fallback", async () => {
  const f = fixture("freebsd");
  expect((await f.result).memFreePct).toBe(25);
  expect(f.reads).toEqual([]);
  expect(f.calls.map((argv) => argv[0])).toEqual(["sysctl", "cat", "cat", "df", "sysctl"]);
});

// One macOS definition: the guard's sample and the platform adapter both read the kernel level memory_pressure prints
// as "System-wide memory free percentage". Memory moves, so each must fall between two memory_pressure reads.
test.skipIf(process.platform !== "darwin")(
  "on macOS the host guard samples the free percentage memory_pressure prints, through the platform adapter",
  async () => {
    const pressure = (): number => {
      const out = Bun.spawnSync(["/usr/bin/memory_pressure", "-Q"], { env: { LC_ALL: "C" } }).stdout.toString();
      const level = /System-wide memory free percentage: (\d+)%/.exec(out)?.[1];
      expect(level).toBeDefined();
      return Number(level);
    };
    const { result, rts } = fixture("darwin");
    await result;
    const before = pressure();
    const adapter = platform.memFreePct();
    const sampled = (await sampleHost(run, "/", rts)).memFreePct;
    const after = pressure();
    for (const value of [adapter, sampled]) {
      expect(value).toBeGreaterThanOrEqual(Math.min(before, after) - 2);
      expect(value).toBeLessThanOrEqual(Math.max(before, after) + 2);
    }
  },
);
