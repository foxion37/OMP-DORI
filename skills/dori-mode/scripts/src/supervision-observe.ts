import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { Checkpoints } from "./checkpoints.ts";
import type { Lane } from "./registry.ts";
import type { Progress } from "./reports.ts";
import type { Runner } from "./run.ts";

// path.relative() writes the platform's separators; a POSIX name may hold a literal backslash, so only Windows splits it.
const PATH_SEPARATOR = process.platform === "win32" ? /[\\/]/ : "/";

export type BudgetLimits = {
  readonly wallMinutes?: number | null | undefined;
  readonly tokens?: number | null | undefined;
  readonly costUsd?: number | null | undefined;
};
export type Usage = { readonly tokens: number | null; readonly costUsd: number | null };
export type UsageSnapshot = Usage & {
  readonly key: string;
  readonly at: string;
  readonly openedAt?: string;
  readonly final?: true;
};
export type SupervisedLane = Lane & { readonly activityPaths?: readonly string[]; readonly budget?: BudgetLimits };
export type SupervisionOptions = {
  readonly hungAfterMinutes?: number;
  readonly staleAfterMinutes?: number;
  readonly defaults?: BudgetLimits;
  readonly lanes?: Readonly<Record<string, BudgetLimits>>;
  readonly usageArgv?: readonly string[];
  readonly recordCostArgv?: readonly string[];
  readonly activityPaths?: readonly string[];
  readonly gitActivity?: boolean;
};
// Match only an explicit duration on a visible Working/Running line. step is the smallest unit shown, in seconds:
// "25m" is rounded to the minute, so two readings can place the same call's start up to a minute apart.
export const workingTimer = (screen: string): { kind: string; seconds: number; step: number } | null => {
  for (const line of Bun.stripANSI(screen).split("\n")) {
    const kind = /^\s*[^\w\n]*(Working|Running)\b/i.exec(line)?.[1]?.toLowerCase();
    if (!kind) continue;
    const clock = /\b(\d+):(\d{2})(?::(\d{2}))?\b/.exec(line);
    if (clock) {
      const seconds =
        clock[3] === undefined
          ? Number(clock[1]) * 60 + Number(clock[2])
          : Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
      return { kind, seconds, step: 1 };
    }
    const parts = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\b/gi)];
    const unit = (name = ""): number => (/^h/i.test(name) ? 3600 : /^m/i.test(name) ? 60 : 1);
    if (parts.length)
      return {
        kind,
        seconds: parts.reduce((sum, match) => sum + Number(match[1]) * unit(match[2]), 0),
        step: Math.min(...parts.map((match) => unit(match[2]))),
      };
  }
  return null;
};

/** Sample files and checkpoints before taking the delivery lock; fold in the current report when committing. */
export const laneActivity = async (
  run: Runner,
  options: SupervisionOptions,
  checkpoints: Checkpoints,
  lane: SupervisedLane,
): Promise<(progress: Progress | null) => string> => {
  const paths = new Set(
    [...(options.activityPaths ?? []), ...(lane.activityPaths ?? [])].map((path) => resolve(lane.cwd ?? ".", path)),
  );
  const changes: string[] = [];
  if (options.gitActivity !== false && lane.cwd) {
    const result = await run(["git", "-C", lane.cwd, "status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
      timeoutMs: 10_000,
      preserveOutput: true,
    });
    if (result.code === 0) {
      const entries = result.out.split("\0");
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        const name = entry.slice(3);
        const path = resolve(lane.cwd, name);
        const rel = relative(resolve(lane.cwd), path);
        const parts = rel.split(PATH_SEPARATOR);
        // Dependency churn and paths outside the lane's cwd are not the lane's progress.
        if (!isAbsolute(rel) && parts[0] !== ".." && !parts.includes("node_modules")) {
          paths.add(path);
          changes.push(entry);
        }
        if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") index++;
      }
    }
  }
  const files = [...paths].sort().map((path) => {
    try {
      const stat = lstatSync(path);
      return [path, stat.mtimeMs, stat.ctimeMs, stat.size];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [path, null];
    }
  });
  const checkpoint = checkpoints.read(lane.key).at(-1) ?? null;
  changes.sort();
  return (progress) => JSON.stringify({ report: progress?.lastReport ?? null, checkpoint, files, changes });
};

export const observeBudget = (options: SupervisionOptions, lane: SupervisedLane, now: number, usage: Usage) => {
  const limits = {
    wallMinutes: null,
    tokens: null,
    costUsd: null,
    ...options.defaults,
    ...options.lanes?.[lane.key],
    ...lane.budget,
  };
  const violations: string[] = [];
  const exceeds = (name: keyof BudgetLimits, actual: number | null): void => {
    const ceiling = limits[name];
    if (typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 0 && actual !== null && actual >= ceiling)
      violations.push(`${name} ceiling reached (${ceiling})`);
  };
  exceeds("wallMinutes", (now - Date.parse(lane.openedAt)) / 60_000);
  exceeds("tokens", usage.tokens);
  exceeds("costUsd", usage.costUsd);
  const unavailable = (["tokens", "costUsd"] as const)
    .filter((name) => typeof limits[name] === "number" && usage[name] === null)
    .map((name) => `${name} ceiling cannot be checked: usage unavailable`);
  return { violations, unavailable };
};
