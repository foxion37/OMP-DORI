import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { formatRef } from "../../../../src/runtime/types.ts";
import { monitorPolicy } from "../../../../src/update/monitor-policy.ts";
import { laneWords } from "./monitor-command.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";
import type { ProgressState } from "./reports.ts";
export type Monitor = {
  /** OMP's desired monitor spec; argv stays structured so a quoted argument is never split into lane keys. */
  readonly name: string;
  readonly mode?: "persistent" | "once" | "daemon";
  readonly restart?: "on-failure" | { readonly max: number; readonly backoffSec: number };
  readonly silentAfterMin?: number;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly filter?: string;
};
export type Manifest = {
  readonly path: string;
  readonly data: { readonly version: number; readonly sessionId: string; readonly monitors: readonly Monitor[] };
};
export type BootLane = Lane & { readonly reportState?: ProgressState | undefined };
export type Cleanup = {
  readonly monitorId: string;
  readonly sessionId: string;
  readonly metadata: string;
  readonly lanes: readonly string[];
  readonly match: readonly string[];
  readonly stop: string;
};
// The one definition of a finished lane, shared by the VANISHED filter and the cleanup check.
export const finished = (lane: BootLane): boolean => {
  const status = statusOf(lane);
  // A watcher or lead objection is authoritative, including before the lane journals its setback.
  const rejected = status === "not-done" || (status === "paused" && lane.pausedFrom === "not-done");
  return (
    status === "closed" ||
    (!lane.threadClosePending && (status === "verified-done" || (!rejected && lane.reportState === "done")))
  );
};

// Loose: any mention of a name, prose and paths included. Used only to keep a watch that might belong to an open lane.
// A colon or a period next to the name is punctuation ("lane:api-release", "api-release.") unless the period joins
// another name ("api.v2" is not "v2").
const mentions = (text: string, value: string | undefined): boolean => {
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-zA-Z0-9_-])(?<![a-zA-Z0-9_-]\\.)${escaped}(?![a-zA-Z0-9_-])(?!\\.[a-zA-Z0-9_-])`).test(
    text,
  );
};

// Strict: the evidence that ties a watch to a lane is the lane's pane id or its key as a whole argv word. A path
// segment is not the lane ("build/docs/out.log" is not "docs").
// A command's own words (monitor-command.ts) never name its lane: `cataly inbound slack` is not lane "slack".
const tiedBy = (monitor: Monitor, lane: Lane): string | null => {
  const ref = sessionOf(lane);
  const panes = [ref?.id, ref ? formatRef(ref) : undefined].filter((id): id is string => !!id);
  if (panes.some((id) => monitor.argv.includes(id))) return `${lane.key}:argv:pane`;
  if (laneWords(monitor.argv, monitor.cwd).includes(lane.key)) return `${lane.key}:argv:key`;
  return null;
};

export const monitorCleanup = (lanes: readonly BootLane[], manifests: readonly Manifest[]): Cleanup[] => {
  const cleanup: Cleanup[] = [];
  for (const { path, data } of manifests) {
    for (const monitor of data.monitors) {
      const tied = lanes.flatMap((lane) => {
        const match = tiedBy(monitor, lane);
        return match ? [{ lane, match }] : [];
      });
      if (!tied.length || tied.some(({ lane }) => !finished(lane))) continue;
      // Any mention of an open lane anywhere in the watch keeps it.
      const text = [monitor.name, ...monitor.argv, monitor.cwd, monitor.filter]
        .filter((v) => typeof v === "string")
        .join("\n");
      if (lanes.some((lane) => !finished(lane) && (mentions(text, lane.key) || mentions(text, lane.sessionRef?.id))))
        continue;
      cleanup.push({
        monitorId: monitor.name,
        sessionId: data.sessionId,
        metadata: path,
        lanes: tied.map(({ lane }) => lane.key),
        match: tied.map(({ match }) => match),
        stop: `monitor(${JSON.stringify({ op: "stop", name: monitor.name })})`,
      });
    }
  }
  return cleanup;
};

const entries = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
};

// One unreadable file is named in errors and skipped; the other sessions' metadata is still read.
export const readMonitorManifests = (dir: string): { manifests: Manifest[]; errors: string[] } => {
  const manifests: Manifest[] = [];
  const errors: string[] = [];
  let files: ReturnType<typeof entries>;
  try {
    files = entries(dir);
  } catch {
    return { manifests, errors: [dir] };
  }
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(dir, entry.name);
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as Manifest["data"];
      if (
        (data.version !== 1 && data.version !== 2 && data.version !== 3) ||
        !Array.isArray(data.monitors) ||
        typeof data.sessionId !== "string" ||
        !data.monitors.every((value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value))
      )
        throw new Error("invalid monitor metadata");
      for (const monitor of data.monitors) monitorPolicy(monitor);
      if (
        !data.monitors.every(
          (monitor) =>
            typeof monitor.name === "string" &&
            monitor.name.length > 0 &&
            (data.version >= 2 || monitor.mode === undefined || monitor.mode === "persistent") &&
            (data.version === 3 ||
              (monitor.mode !== "daemon" &&
                (monitor.restart === undefined || monitor.restart === "on-failure") &&
                monitor.silentAfterMin === undefined)) &&
            Array.isArray(monitor.argv) &&
            monitor.argv.length > 0 &&
            monitor.argv.every((arg: unknown) => typeof arg === "string") &&
            typeof monitor.cwd === "string" &&
            (monitor.filter === undefined || typeof monitor.filter === "string"),
        )
      )
        throw new Error("invalid OMP monitor spec");
      manifests.push({ path, data });
    } catch {
      errors.push(path);
    }
  }
  return { manifests, errors };
};
