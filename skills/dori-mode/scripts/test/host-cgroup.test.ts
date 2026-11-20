import { expect, test } from "bun:test";
import { alertReasons, guardTick, sampleHost } from "../src/host-guard.ts";
import { canLaunch } from "../src/routing.ts";
import { type Runner, runtimesFor } from "../src/run.ts";

const thresholds = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 0, panesMax: 20 };
const runner: Runner = async (argv) => {
  let out = "";
  if (argv[0] === "cat")
    out = argv[1] === "/proc/meminfo" ? "MemTotal: 1000 kB\nMemAvailable: 800 kB\n" : "0.5 0.4 0.3 1/200 999";
  else if (argv[0] === "df") out = "Filesystem 1K-blocks Used Available Use% Mounted\n/dev/x 1000 500 524288 50% /";
  else if (argv[0] === "herdr") out = '{"result":{"panes":[]}}';
  else return { code: 127, out: "", err: "not found" };
  return { code: 0, out, err: "" };
};
const noCache = "file 0\nshmem 0\nfile_mapped 0\nfile_dirty 0\nfile_writeback 0\n";
const files = (parent: Record<string, string> = {}) => ({
  "/proc/loadavg": "0.5 0.4 0.3 1/200 999",
  "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 800 kB\n",
  "/proc/self/cgroup": "0::/account/worker\n",
  "/proc/self/mountinfo": "29 20 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
  "/sys/fs/cgroup/account/worker/memory.current": "10",
  "/sys/fs/cgroup/account/worker/memory.max": "max",
  "/sys/fs/cgroup/account/worker/memory.high": "max",
  "/sys/fs/cgroup/account/memory.current": "950",
  "/sys/fs/cgroup/account/memory.max": "1000",
  "/sys/fs/cgroup/account/memory.high": "max",
  "/sys/fs/cgroup/account/memory.stat": noCache,
  "/sys/fs/cgroup/account/worker/memory.stat": noCache,
  ...parent,
});
const sample = (data: Record<string, string>, platform: NodeJS.Platform = "linux") =>
  sampleHost(runner, "/", runtimesFor({ runtime: "herdr" }, {}, runner), {
    platform,
    readFile: (path) => {
      const text = data[path];
      if (text === undefined) throw Object.assign(new Error(`unreadable ${path}`), { code: "ENOENT" });
      return text;
    },
  });

test("an unlimited leaf cannot hide a busy ancestor from guard or can-launch", async () => {
  const s = await sample(files());
  expect(s.memFreePct).toBe(80);
  expect(s.cgroup?.hard).toEqual({
    path: "/sys/fs/cgroup/account",
    limitBytes: 1000,
    currentBytes: 950,
    reclaimableBytes: 0,
    chargedFreePct: 5,
    freePct: 5,
  });
  expect(canLaunch(s, thresholds)).toEqual({ ok: false, reasons: ["cgroup v2 hard headroom 5.0% < 20%"] });
  expect(guardTick(s, thresholds, { alerting: false, computeReady: true })).toEqual([
    "HOST_GUARD ALERT cgroup v2 hard headroom 5.0% < 20%",
  ]);
});

test("v2 high is a separate throttle budget, not the hard limit", async () => {
  const s = await sample(
    files({
      "/sys/fs/cgroup/account/memory.max": "2000",
      "/sys/fs/cgroup/account/memory.high": "1000",
    }),
  );
  expect(s.cgroup?.hard?.freePct).toBe(52.5);
  expect(s.cgroup?.high?.freePct).toBe(5);
  expect(alertReasons(s, thresholds)).toEqual(["cgroup v2 high headroom 5.0% < 20%"]);
  expect(canLaunch(s, thresholds).ok).toBe(false);
});

test("the tightest hard and high percentages can belong to different ancestors", async () => {
  const s = await sample(
    files({
      "/sys/fs/cgroup/account/worker/memory.current": "85",
      "/sys/fs/cgroup/account/worker/memory.max": "1000",
      "/sys/fs/cgroup/account/worker/memory.high": "100",
    }),
  );
  expect(s.cgroup?.hard?.path).toBe("/sys/fs/cgroup/account");
  expect(s.cgroup?.high?.path).toBe("/sys/fs/cgroup/account/worker");
  expect(canLaunch(s, thresholds).reasons).toHaveLength(2);
});

test.each([
  ["0", "0", 0],
  ["1000", "1100", 0],
  ["1000", "800", 20],
  ["10000", "8001", 19.99],
])("limit %s and usage %s preserve the exact admission boundary", async (limit, current, free) => {
  const s = await sample(
    files({
      "/sys/fs/cgroup/account/memory.max": limit,
      "/sys/fs/cgroup/account/memory.current": current,
    }),
  );
  expect(s.cgroup?.hard?.freePct).toBeCloseTo(free);
  expect(canLaunch(s, thresholds).ok).toBe(free >= 20);
});

test.each(["hard", "high"] as const)("near-threshold %s reasons stay below the admission threshold", async (kind) => {
  const s = await sample(
    files({
      "/sys/fs/cgroup/account/memory.max": kind === "hard" ? "10000" : "max",
      "/sys/fs/cgroup/account/memory.high": kind === "high" ? "10000" : "max",
      "/sys/fs/cgroup/account/memory.current": "8001",
    }),
  );
  expect(s.cgroup?.[kind]?.freePct).toBeCloseTo(19.99);
  const reason = `cgroup v2 ${kind} headroom 19.9% < 20%`;
  expect(canLaunch(s, thresholds)).toEqual({ ok: false, reasons: [reason] });
  expect(guardTick(s, thresholds, { alerting: false, computeReady: true })).toEqual([`HOST_GUARD ALERT ${reason}`]);
});

test("cgroup headroom never overrides a low host-memory alert", async () => {
  const s = await sample(files({ "/sys/fs/cgroup/account/memory.current": "0" }));
  expect(canLaunch({ ...s, memFreePct: 10 }, thresholds).reasons).toEqual(["memory free 10% < 20%"]);
});

test("partial reads remain visible and do not discard another valid budget", async () => {
  const data: Record<string, string> = files({ "/sys/fs/cgroup/account/memory.high": "1000" });
  delete data["/sys/fs/cgroup/account/memory.max"];
  const s = await sample(data);
  expect(s.cgroup?.incomplete).toBe(true);
  expect(s.cgroup?.hard).toBeNull();
  expect(canLaunch(s, thresholds).ok).toBe(false);
});

test("missing controller data keeps the host fallback distinguishable from unlimited", async () => {
  expect((await sample({})).cgroup?.incomplete).toBe(true);
  const s = await sample(files({ "/sys/fs/cgroup/account/memory.max": "max" }));
  expect(s.cgroup).toEqual({ version: 2, hard: null, high: null, incomplete: false });
  expect(canLaunch(s, thresholds).ok).toBe(true);
});

test("clean file cache does not permanently hold admission while anonymous pressure does", async () => {
  const cached = await sample(
    files({
      "/sys/fs/cgroup/account/memory.high": "1000",
      "/sys/fs/cgroup/account/memory.stat": "file 800\nshmem 0\nfile_mapped 0\nfile_dirty 0\nfile_writeback 0\n",
    }),
  );
  expect(cached.cgroup?.hard?.chargedFreePct).toBe(5);
  expect(cached.cgroup?.hard?.reclaimableBytes).toBe(800);
  expect(cached.cgroup?.high?.freePct).toBe(85);
  expect(canLaunch(cached, thresholds).ok).toBe(true);
  const anonymous = await sample(files({ "/sys/fs/cgroup/account/memory.high": "1000" }));
  expect(canLaunch(anonymous, thresholds).ok).toBe(false);
});

test("shared, mapped, dirty and writeback pages are not counted as available cache", async () => {
  const s = await sample(
    files({
      "/sys/fs/cgroup/account/memory.stat":
        "file 800\nshmem 200\nfile_mapped 200\nfile_dirty 100\nfile_writeback 100\n",
    }),
  );
  expect(s.cgroup?.hard?.reclaimableBytes).toBe(200);
  expect(s.cgroup?.hard?.freePct).toBe(25);
  expect(canLaunch(s, { ...thresholds, memFreeMinPct: 30 }).ok).toBe(false);
});

test.each([undefined, "file 800\n", "file -1\nshmem 0\nfile_mapped 0\nfile_dirty 0\nfile_writeback 0\n"])(
  "missing or malformed cache statistics retain the raw charged protection: %s",
  async (stat) => {
    const data: Record<string, string> = files();
    if (stat === undefined) delete data["/sys/fs/cgroup/account/memory.stat"];
    else data["/sys/fs/cgroup/account/memory.stat"] = stat;
    const s = await sample(data);
    expect(s.cgroup?.incomplete).toBe(true);
    expect(s.cgroup?.hard?.freePct).toBe(5);
    expect(canLaunch(s, thresholds).ok).toBe(false);
  },
);

test("macOS does not read Linux cgroups", async () => {
  const s = await sampleHost(runner, "/", runtimesFor({ runtime: "herdr" }, {}, runner), {
    platform: "darwin",
    readFile: () => {
      throw new Error("must not read Linux files");
    },
  });
  expect(s.cgroup).toBeUndefined();
  expect(s.memFreePct).toBe(80);
});
