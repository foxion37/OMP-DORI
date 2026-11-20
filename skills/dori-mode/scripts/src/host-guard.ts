import { readFileSync } from "node:fs";
import { type CgroupMemory, sampleCgroupMemory } from "./cgroup-memory.ts";
import type { GuardThresholds } from "./config.ts";
import { type ChosenRuntimes, type Runner, runtimesFor } from "./run.ts";
import { listSessions } from "./sessions.ts";

export type HostSample = {
  readonly load1: number;
  readonly memFreePct: number;
  readonly cgroup?: CgroupMemory;
  readonly diskFreeGb: number;
  readonly swapFreeGb: number;
  readonly panes: number;
};

const num = (s: string | undefined, fallback: number): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

export const sampleHost = async (
  run: Runner,
  dataPath = "/",
  rts: ChosenRuntimes = runtimesFor({}, process.env, run),
  system: { platform?: NodeJS.Platform; readFile?: (path: string) => string } = {},
): Promise<HostSample> => {
  const linux = (system.platform ?? process.platform) === "linux";
  const readProc = (path: string): string => {
    try {
      return system.readFile ? system.readFile(path) : readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  const load = linux ? null : await run(["sysctl", "-n", "vm.loadavg"]);
  const loadText =
    load?.code === 0
      ? load.out.replace(/[{}]/g, "")
      : linux
        ? readProc("/proc/loadavg")
        : (await run(["cat", "/proc/loadavg"])).out;
  const load1 = num(loadText.trim().split(/\s+/)[0], 0);
  const mp = linux ? null : await run(["memory_pressure", "-Q"]);
  const memInfo = mp?.code === 0 ? "" : linux ? readProc("/proc/meminfo") : (await run(["cat", "/proc/meminfo"])).out;
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(memInfo);
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal"),
    available = kb("MemAvailable");
  const memFreePct =
    mp?.code === 0
      ? num(/free percentage: (\d+)%/.exec(mp.out)?.[1], 100)
      : total !== null && total > 0 && available !== null
        ? Math.round((available / total) * 100)
        : 100;
  const df = await run(["df", "-k", dataPath]);
  const diskFreeGb = num(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3], 0) / 1_048_576;
  const swap = linux ? null : await run(["sysctl", "-n", "vm.swapusage"]);
  const swapFreeGb = num(/free = ([\d.]+)M/.exec(swap?.out ?? "")?.[1], 0) / 1024;
  // A failed session list (no runtime, a refused call) is -1, never 0: an unknown count must not pass the guard.
  const panes = await listSessions(rts).then(
    (sessions) => sessions.length,
    () => -1,
  );
  const cgroup = linux ? sampleCgroupMemory(system.readFile) : undefined;
  return { load1, memFreePct, diskFreeGb, swapFreeGb, panes, ...(cgroup ? { cgroup } : {}) };
};

export const memoryReasons = (s: HostSample, t: GuardThresholds): string[] => {
  const reasons: string[] = [];
  if (s.memFreePct < t.memFreeMinPct) reasons.push(`memory free ${s.memFreePct}% < ${t.memFreeMinPct}%`);
  for (const kind of ["hard", "high"] as const) {
    const budget = s.cgroup?.[kind];
    if (budget && budget.freePct < t.memFreeMinPct)
      reasons.push(
        `cgroup v${s.cgroup?.version} ${kind} headroom ${(Math.floor(budget.freePct * 10) / 10).toFixed(1)}% < ${t.memFreeMinPct}%`,
      );
  }
  return reasons;
};

export const alertReasons = (s: HostSample, t: GuardThresholds): string[] => {
  const r: string[] = [];
  if (s.load1 > t.loadAlert) r.push(`load ${s.load1.toFixed(0)} > ${t.loadAlert}`);
  r.push(...memoryReasons(s, t));
  if (s.diskFreeGb < t.diskFreeMinGb) r.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes < 0) r.push("session count unknown");
  if (t.panesMax > 0 && s.panes > t.panesMax) r.push(`panes ${s.panes} > ${t.panesMax}`);
  return r;
};

export type GuardState = { alerting: boolean; computeReady?: boolean };

export const guardTick = (s: HostSample, t: GuardThresholds, state: GuardState): string[] => {
  const out: string[] = [];
  const reasons = alertReasons(s, t);
  const alerting = reasons.length > 0;
  if (alerting !== state.alerting) {
    out.push(
      alerting
        ? `HOST_GUARD ALERT ${reasons.join(" | ")}`
        : `HOST_GUARD CLEAR load ${s.load1.toFixed(0)}, memory free ${s.memFreePct}%, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`,
    );
    state.alerting = alerting;
  }
  const ready = s.load1 < t.loadOk;
  if (ready !== state.computeReady) {
    out.push(
      ready
        ? `HOST_GUARD COMPUTE_READY load ${s.load1.toFixed(0)} < ${t.loadOk}`
        : `HOST_GUARD COMPUTE_BUSY load ${s.load1.toFixed(0)}`,
    );
    state.computeReady = ready;
  }
  return out;
};
