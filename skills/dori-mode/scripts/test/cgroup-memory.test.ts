import { expect, test } from "bun:test";
import { sampleCgroupMemory } from "../src/cgroup-memory.ts";

const sample = (files: Record<string, string>, seen: string[] = []) =>
  sampleCgroupMemory((path) => {
    seen.push(path);
    if (!(path in files)) throw Object.assign(new Error(`not readable: ${path}`), { code: "ENOENT" });
    return files[path]!;
  });
const noCache = "file 0\nshmem 0\nfile_mapped 0\nfile_dirty 0\nfile_writeback 0\n";
const v2 = {
  "/proc/self/cgroup": "0::/group/leaf",
  "/proc/self/mountinfo": "1 0 0:1 / /cg rw shared:1 - cgroup2 cgroup rw",
  "/cg/group/leaf/memory.max": "max",
  "/cg/group/leaf/memory.high": "max",
  "/cg/group/memory.max": "1000",
  "/cg/group/memory.high": "max",
  "/cg/group/memory.current": "950",
  "/cg/group/memory.stat": noCache,
};

test("a visible v2 hierarchy without non-root memory interfaces retains its version and marks incomplete", () => {
  expect(
    sample({
      "/proc/self/cgroup": v2["/proc/self/cgroup"],
      "/proc/self/mountinfo": v2["/proc/self/mountinfo"],
    }),
  ).toEqual({ version: 2, hard: null, high: null, incomplete: true });
});

test("v1 uses the memory mount and ancestor usage, not the soft-limit hint", () => {
  const s = sample({
    "/proc/self/cgroup": "0::/unified\n5:cpu,cpuacct:/jobs\n7:memory:/account/leaf",
    "/proc/self/mountinfo": "1 0 0:1 / /unified rw - cgroup2 cgroup rw\n2 0 0:2 / /memory rw - cgroup cgroup rw,memory",
    "/memory/account/leaf/memory.limit_in_bytes": "9223372036854771712",
    "/memory/account/leaf/memory.use_hierarchy": "1",
    "/memory/account/memory.use_hierarchy": "1",
    "/memory/account/memory.limit_in_bytes": "1000",
    "/memory/account/memory.usage_in_bytes": "900",
    "/memory/account/memory.stat":
      "total_cache 0\ntotal_shmem 0\ntotal_mapped_file 0\ntotal_dirty 0\ntotal_writeback 0\n",
    "/memory/account/memory.soft_limit_in_bytes": "500",
    "/memory/memory.use_hierarchy": "1",
    "/memory/memory.limit_in_bytes": "9223372036854771712",
  });
  expect(s).toEqual({
    version: 1,
    hard: {
      path: "/memory/account",
      limitBytes: 1000,
      currentBytes: 900,
      reclaimableBytes: 0,
      chargedFreePct: 10,
      freePct: 10,
    },
    high: null,
    incomplete: false,
  });
});

test("non-hierarchical v1 ancestors do not constrain descendants", () => {
  const s = sample({
    "/proc/self/cgroup": "7:memory:/leaf",
    "/proc/self/mountinfo": "1 0 0:1 / /memory rw - cgroup cgroup rw,memory",
    "/memory/leaf/memory.limit_in_bytes": "1000",
    "/memory/leaf/memory.usage_in_bytes": "100",
    "/memory/leaf/memory.use_hierarchy": "0",
    "/memory/leaf/memory.stat": "cache 0\nshmem 0\nmapped_file 0\ndirty 0\nwriteback 0\n",
    "/memory/memory.use_hierarchy": "0",
    "/memory/memory.limit_in_bytes": "100",
    "/memory/memory.usage_in_bytes": "99",
  });
  expect(s.hard?.freePct).toBe(90);
});

test("subtree mount roots and escaped paths are resolved without escaping the mount", () => {
  const seen: string[] = [];
  const s = sample(
    {
      "/proc/self/cgroup": "0::/tenant name/leaf",
      "/proc/self/mountinfo": "1 0 0:1 /tenant\\040name /mount\\040point rw - cgroup2 cgroup rw",
      "/mount point/leaf/memory.max": "max",
      "/mount point/leaf/memory.high": "max",
      "/mount point/memory.max": "1000",
      "/mount point/memory.high": "max",
      "/mount point/memory.current": "950",
      "/mount point/memory.stat": noCache,
    },
    seen,
  );
  expect(s.hard?.path).toBe("/mount point");
  expect(s.hard?.freePct).toBe(5);
  expect(seen.some((p) => p === "/memory.max")).toBe(false);
});

test.each(["job ", " job", "job\t"])("membership preserves the exact cgroup name %j", (name) => {
  const s = sample({
    "/proc/self/cgroup": `0::/${name}\n`,
    "/proc/self/mountinfo": "1 0 0:1 / /cg rw - cgroup2 cgroup rw\n",
    [`/cg/${name}/memory.max`]: "1000\n",
    [`/cg/${name}/memory.high`]: "max\n",
    [`/cg/${name}/memory.current`]: "950\n",
    [`/cg/${name}/memory.stat`]: noCache,
  });
  expect(s.hard?.path).toBe(`/cg/${name}`);
  expect(s.hard?.freePct).toBe(5);
  expect(s.incomplete).toBe(false);
});

test("a wider visible mount wins over a subtree bind", () => {
  const s = sample({
    ...v2,
    "/proc/self/mountinfo": `2 0 0:1 /group/leaf /bind rw - cgroup2 cgroup rw\n${v2["/proc/self/mountinfo"]}`,
  });
  expect(s.hard?.path).toBe("/cg/group");
});

test("a namespace root stops at its visible mount root", () => {
  const s = sample({
    "/proc/self/cgroup": "0::/",
    "/proc/self/mountinfo": "1 0 0:1 / /cg rw - cgroup2 cgroup rw",
    "/cg/memory.max": "1000",
    "/cg/memory.high": "max",
    "/cg/memory.current": "900",
    "/cg/memory.stat": noCache,
  });
  expect(s.hard?.freePct).toBe(10);
});

test.each(["-1", "1garbage", "", "NaN", "9007199254740992"])(
  "malformed hard limit %s is unknown, not unlimited",
  (limit) => {
    const s = sample({ ...v2, "/cg/group/memory.max": limit });
    expect(s.hard).toBeNull();
    expect(s.incomplete).toBe(true);
  },
);

test("unreadable current usage leaves valid ancestor evidence intact", () => {
  const s = sample({ ...v2, "/cg/group/leaf/memory.max": "100" });
  expect(s.incomplete).toBe(true);
  expect(s.hard?.freePct).toBe(5);
});

test.each(["0", "1"])("v1 uses matching %s hierarchy cache counters", (hierarchy) => {
  const prefix = hierarchy === "1" ? "total_" : "";
  const s = sample({
    "/proc/self/cgroup": "7:memory:/",
    "/proc/self/mountinfo": "1 0 0:1 / /memory rw - cgroup cgroup rw,memory",
    "/memory/memory.use_hierarchy": hierarchy,
    "/memory/memory.limit_in_bytes": "1000",
    "/memory/memory.usage_in_bytes": "950",
    "/memory/memory.stat": `${prefix}cache 800\n${prefix}shmem 100\n${prefix}mapped_file 50\n${prefix}dirty 25\n${prefix}writeback 25\n`,
  });
  expect(s.hard?.reclaimableBytes).toBe(600);
  expect(s.hard?.freePct).toBe(65);
  expect(s.incomplete).toBe(false);
});

test.each(["file 100\nshmem 200", "file 9999\nshmem 0"])(
  "cache estimate is clamped within charged usage: %s",
  (stat) => {
    const s = sample({ ...v2, "/cg/group/memory.stat": `${stat}\nfile_mapped 0\nfile_dirty 0\nfile_writeback 0\n` });
    expect(s.hard?.reclaimableBytes).toBe(stat.startsWith("file 100\n") ? 0 : 950);
  },
);

test("permission failures at the mount root remain incomplete", () => {
  const s = sampleCgroupMemory((path) => {
    if (path === "/proc/self/cgroup") return "0::/";
    if (path === "/proc/self/mountinfo") return "1 0 0:1 / /cg rw - cgroup2 cgroup rw";
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  });
  expect(s.incomplete).toBe(true);
  expect(s.hard).toBeNull();
});

test("missing controllers, missing mounts and invalid membership are distinguishable", () => {
  expect(sample({ "/proc/self/cgroup": "2:cpu:/", "/proc/self/mountinfo": "" })).toEqual({
    version: null,
    hard: null,
    high: null,
    incomplete: false,
  });
  expect(sample({ ...v2, "/proc/self/mountinfo": "" }).incomplete).toBe(true);
  const seen: string[] = [];
  expect(sample({ ...v2, "/proc/self/cgroup": "0::/../escape" }, seen).incomplete).toBe(true);
  expect(seen).toEqual(["/proc/self/cgroup", "/proc/self/mountinfo"]);
});
