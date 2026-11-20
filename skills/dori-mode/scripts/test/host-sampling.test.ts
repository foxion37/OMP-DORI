import { expect, test } from "bun:test";
import { sampleHost } from "../src/host-guard.ts";
import { canLaunch } from "../src/routing.ts";
import { type Runner, runtimesFor } from "../src/run.ts";

const loadavg = "0.50 0.40 0.30 1/200 999\n";
const meminfo = "MemTotal: 16000000 kB\nMemAvailable: 4000000 kB\n";
const fixture = (
  platform: NodeJS.Platform,
  options: { mac?: boolean; sessionFailure?: boolean; memory?: string | null; load?: string | null } = {},
) => {
  const calls: string[][] = [],
    reads: string[] = [];
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
    else if (argv[0] === "herdr" && !options.sessionFailure) out = '{"result":{"panes":[]}}';
    else return { code: 127, out: "", err: "unavailable" };
    return { code: 0, out, err: "" };
  };
  const result = sampleHost(runner, "/data path", runtimesFor({ runtime: "herdr" }, {}, runner), {
    platform,
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
  return { result, calls, reads };
};

test("Linux reads proc directly and only spawns df and the selected session list", async () => {
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
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]).toEqual(["df", "-k", "/data path"]);
  expect(f.calls[1]?.[0]).toBe("herdr");
});

test.each([null, "MemTotal: 16000000 kB\n", "MemTotal: 0 kB\nMemAvailable: 0 kB\n", "invalid"])(
  "unavailable or malformed Linux memory keeps the existing 100 percent fallback: %s",
  async (memory) => {
    const f = fixture("linux", { memory, load: null });
    const s = await f.result;
    expect(s.memFreePct).toBe(100);
    expect(s.load1).toBe(0);
    expect(f.calls).toHaveLength(2);
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

test.each(["darwin", "freebsd"] as const)(
  "%s retains successful sysctl, memory_pressure and swap probes",
  async (platform) => {
    const f = fixture(platform, { mac: true });
    expect(await f.result).toEqual({ load1: 1.25, memFreePct: 42, diskFreeGb: 0.5, swapFreeGb: 2, panes: 0 });
    expect(f.reads).toEqual([]);
    expect(f.calls.map((argv) => argv[0])).toEqual(["sysctl", "memory_pressure", "df", "sysctl", "herdr"]);
  },
);

test("non-Linux probe failures retain the legacy runner fallback", async () => {
  const f = fixture("darwin");
  expect((await f.result).memFreePct).toBe(25);
  expect(f.reads).toEqual([]);
  expect(f.calls.map((argv) => argv[0])).toEqual(["sysctl", "cat", "memory_pressure", "cat", "df", "sysctl", "herdr"]);
});
