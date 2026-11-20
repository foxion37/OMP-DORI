import { readFileSync } from "node:fs";
import { posix } from "node:path";

type Headroom = {
  readonly path: string;
  readonly limitBytes: number;
  readonly currentBytes: number;
  readonly reclaimableBytes: number;
  readonly chargedFreePct: number;
  readonly freePct: number;
};
export type CgroupMemory = {
  readonly version: 1 | 2 | null;
  hard: Headroom | null;
  high: Headroom | null;
  incomplete: boolean;
};

/** Read only the visible memory hierarchy; a cgroup namespace can hide outer limits. */
export const sampleCgroupMemory = (readFile = (path: string): string => readFileSync(path, "utf8")): CgroupMemory => {
  const result: CgroupMemory = { version: null, hard: null, high: null, incomplete: false };
  const read = (path: string, optional = false): string | undefined => {
    try {
      return readFile(path);
    } catch (error) {
      if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT") result.incomplete = true;
      return undefined;
    }
  };
  const membership = read("/proc/self/cgroup"),
    mounts = read("/proc/self/mountinfo");
  if (membership === undefined || mounts === undefined) return { ...result, incomplete: true };
  const groups = membership.split("\n").map((line) => /^([^:]*):([^:]*):(.*)$/.exec(line));
  // On hybrid hosts the memory controller may still belong to v1, not the unified hierarchy.
  const legacy = groups.find((group) => group?.[2]?.split(",").includes("memory"));
  const group = legacy ?? groups.find((entry) => entry?.[1] === "0" && entry[2] === "");
  if (!group) return result;
  const version = legacy ? 1 : 2;
  const path = group[3] ?? "";
  if (!path.startsWith("/") || path.split("/").includes("..")) return { ...result, version, incomplete: true };
  const decodeMountPath = (value: string): string =>
    value.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
  const candidates = mounts.split("\n").flatMap((line) => {
    const [left, right] = line.split(" - ");
    const fields = left?.split(" "),
      fs = right?.split(" ");
    if (!fields?.[3] || !fields[4] || !fs) return [];
    if (version === 2 ? fs[0] !== "cgroup2" : fs[0] !== "cgroup" || !fs[2]?.split(",").includes("memory")) return [];
    const root = decodeMountPath(fields[3]),
      mount = decodeMountPath(fields[4]);
    if (!root.startsWith("/") || !mount.startsWith("/")) return [];
    return root === "/" || path === root || path.startsWith(`${root}/`) ? [{ root, mount }] : [];
  });
  // Prefer the widest visible mount, so a subtree bind does not hide a constrained ancestor.
  candidates.sort((a, b) => a.root.length - b.root.length);
  const mount = candidates[0];
  if (!mount) return { ...result, version, incomplete: true };
  const sample: CgroupMemory = { ...result, version };
  const leaf = posix.join(mount.mount, posix.relative(mount.root, path));
  const bytes = (value: string | undefined): number | undefined => {
    if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : undefined;
  };
  for (let dir = leaf; ; dir = posix.dirname(dir)) {
    const atRoot = dir === mount.mount;
    const hierarchy = version === 1 ? read(`${dir}/memory.use_hierarchy`)?.trim() : "1";
    if (version === 2 || dir === leaf || hierarchy === "1") {
      let reclaimableBytes: number | undefined;
      const limits = version === 2 ? ["memory.max", "memory.high"] : ["memory.limit_in_bytes"];
      const current = read(dir + (version === 2 ? "/memory.current" : "/memory.usage_in_bytes"), true);
      for (const [index, file] of limits.entries()) {
        const text = read(`${dir}/${file}`, atRoot && version === 2)?.trim();
        // The v2 root has no memory controller interface files. v1's page-aligned LONG_MAX is unlimited.
        if ((atRoot && version === 2 && text === undefined) || (version === 2 && text === "max")) continue;
        if (version === 1 && text !== undefined && /^\d+$/.test(text) && BigInt(text) >= 1n << 60n) continue;
        const limitBytes = bytes(text),
          currentBytes = bytes(current);
        if (limitBytes === undefined || currentBytes === undefined) {
          sample.incomplete = true;
          continue;
        }
        if (reclaimableBytes === undefined) {
          const stat = read(`${dir}/memory.stat`) ?? "";
          const keys =
            version === 2
              ? ["file", "shmem", "file_mapped", "file_dirty", "file_writeback"]
              : ["cache", "shmem", "mapped_file", "dirty", "writeback"].map((key) =>
                  hierarchy === "1" ? `total_${key}` : key,
                );
          const counts = keys.map((key) => bytes(new RegExp(`^${key} ([0-9]+)$`, "m").exec(stat)?.[1]));
          if ((hierarchy === "0" || hierarchy === "1") && counts.every((n): n is number => n !== undefined)) {
            // Clean, unmapped file cache can be reclaimed; shared, mapped and in-flight pages are not budget.
            reclaimableBytes = Math.min(
              currentBytes,
              Math.max(
                0,
                counts.reduce((n, value, i) => (i === 0 ? value : n - value), 0),
              ),
            );
          } else {
            sample.incomplete = true;
            reclaimableBytes = 0;
          }
        }
        const chargedFreePct = limitBytes === 0 ? 0 : Math.max(0, ((limitBytes - currentBytes) / limitBytes) * 100);
        const freePct =
          limitBytes === 0 ? 0 : Math.max(0, ((limitBytes - currentBytes + reclaimableBytes) / limitBytes) * 100);
        const key = index === 0 ? "hard" : "high";
        if (!sample[key] || freePct < sample[key].freePct)
          sample[key] = { path: dir, limitBytes, currentBytes, reclaimableBytes, chargedFreePct, freePct };
      }
    }
    if (atRoot) break;
  }
  return { ...sample, incomplete: sample.incomplete || result.incomplete };
};
