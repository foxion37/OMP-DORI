import { readFileSync } from "node:fs";
import { platform } from "../../../../src/platform/index.ts";
import type { RuntimeKind } from "../../../../src/runtime/types.ts";
import { type CgroupMemory, sampleCgroupMemory } from "./cgroup-memory.ts";
import type { GuardThresholds } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type ChosenRuntimes, type Runner, runtimesFor, runtimesOf } from "./run.ts";
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
  system: { platform?: NodeJS.Platform; readFile?: (path: string) => string; memFreePct?: () => number } = {},
): Promise<HostSample> => {
  const os = system.platform ?? process.platform;
  const linux = os === "linux";
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
  // macOS has one definition, the platform adapter's (kern.memorystatus_level, then free pages, then 0); tests inject
  // it. Linux reads MemAvailable, and an unreadable or malformed /proc/meminfo keeps the default 100.
  const darwinMemory = os === "darwin" ? (system.memFreePct ? system.memFreePct() : platform.memFreePct()) : null;
  const memInfo =
    darwinMemory !== null ? "" : linux ? readProc("/proc/meminfo") : (await run(["cat", "/proc/meminfo"])).out;
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(memInfo);
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal"),
    available = kb("MemAvailable");
  const memFreePct =
    darwinMemory ?? (total !== null && total > 0 && available !== null ? Math.round((available / total) * 100) : 100);
  const df = await run(["df", "-k", dataPath]);
  const diskFreeGb = num(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3], 0) / 1_048_576;
  const swap = linux ? null : await run(["sysctl", "-n", "vm.swapusage"]);
  const swapFreeGb = num(/free = ([\d.]+)M/.exec(swap?.out ?? "")?.[1], 0) / 1024;
  // A failed session list (no runtime, a refused call) is -1, never 0: an unknown count must not pass the guard.
  const panes = await listSessions(rts).then(
    (sessions) =>
      sessions.some(
        (session) => session.ref.runtime === "headless" && (session.status === "unknown" || session.status === "error"),
      )
        ? -1
        : sessions.length,
    () => -1,
  );
  const cgroup = linux ? sampleCgroupMemory(system.readFile) : undefined;
  return { load1, memFreePct, diskFreeGb, swapFreeGb, panes, ...(cgroup ? { cgroup } : {}) };
};

/** A fresh CLI has no cached adapters: count the actual open lanes and the requested backend before admitting work. */
export async function sampleLaneHost(deps: FlowDeps, dataPath: string, requested?: RuntimeKind): Promise<HostSample> {
  const runtimes = runtimesOf(deps);
  if (requested) runtimes.for({ runtime: requested, id: "" });
  for (const lane of await deps.registry.open()) if (lane.sessionRef) runtimes.for(lane.sessionRef);
  return sampleHost(deps.run, dataPath, runtimes);
}

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
