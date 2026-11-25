import { isCatalyEntry, SESSION_WIRE } from "../skills/cataly-mode/scripts/src/session-compat.ts";
import { monitorPolicy } from "../src/update/monitor-policy.ts";
import type { MonitorSpec } from "../src/update/deployment-types.ts";
import type { MonitorExit } from "./monitor.ts";

export const MONITOR_ENTRY = SESSION_WIRE.monitor;
type Entry = { readonly type: string; readonly customType?: string; readonly data?: unknown };
export type RecordedMonitor = {
  readonly spec: MonitorSpec;
  readonly id?: string;
  readonly exit?: MonitorExit;
  readonly completed: boolean;
};

const exitRecord = (value: unknown): MonitorExit | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const exit = value as Record<string, unknown>;
  if (
    !(
      exit["code"] === null ||
      (typeof exit["code"] === "number" && Number.isInteger(exit["code"]) && exit["code"] >= 0)
    ) ||
    !(exit["signal"] === null || typeof exit["signal"] === "string") ||
    typeof exit["at"] !== "string" ||
    !Number.isFinite(Date.parse(exit["at"])) ||
    !(exit["error"] === undefined || typeof exit["error"] === "string") ||
    !(
      exit["restartAttempt"] === undefined ||
      (typeof exit["restartAttempt"] === "number" &&
        Number.isSafeInteger(exit["restartAttempt"]) &&
        exit["restartAttempt"] >= 0 &&
        exit["restartAttempt"] <= 100)
    ) ||
    !(exit["exhausted"] === undefined || typeof exit["exhausted"] === "boolean")
  )
    return;
  return {
    code: exit["code"],
    signal: exit["signal"],
    at: exit["at"],
    ...(exit["error"] === undefined ? {} : { error: exit["error"] }),
    ...(exit["restartAttempt"] === undefined ? {} : { restartAttempt: exit["restartAttempt"] }),
    ...(exit["exhausted"] === undefined ? {} : { exhausted: exit["exhausted"] }),
  };
};

/** Replay only this branch's structured monitor records, including durable terminal outcomes. */
export function recordedMonitorStates(branch: readonly Entry[]): Map<string, RecordedMonitor> {
  const states = new Map<string, RecordedMonitor>();
  for (const entry of branch) {
    if (
      entry.type !== "custom" ||
      !isCatalyEntry(entry.customType, "omp-cataly:monitor") ||
      typeof entry.data !== "object" ||
      entry.data === null
    )
      continue;
    const data = entry.data as Record<string, unknown>;
    if (typeof data["name"] !== "string") continue;
    const name = data["name"];
    if (data["op"] === "stop" && data["exit"] === undefined) {
      states.delete(name);
    } else if (
      data["op"] === "start" &&
      Array.isArray(data["argv"]) &&
      typeof data["filter"] === "string" &&
      typeof data["cwd"] === "string"
    ) {
      states.set(name, {
        spec: {
          name,
          argv: data["argv"].map(String),
          filter: data["filter"],
          cwd: data["cwd"],
          ...(data["mode"] === "once" ? { mode: "once" } : {}),
          ...(data["restart"] === "on-failure" ? { restart: "on-failure" } : {}),
          ...monitorPolicy({ ...data, restart: data["restart"] === "on-failure" ? undefined : data["restart"] }),
        },
        ...(typeof data["id"] === "string" ? { id: data["id"] } : {}),
        completed: false,
      });
    } else if (data["op"] === "exit" || data["op"] === "stop") {
      const previous = states.get(name);
      const exit = exitRecord(data["exit"]);
      if (!previous || previous.completed || data["id"] !== previous.id || !exit) continue;
      const completed = data["op"] === "stop";
      const restart = previous.spec.restart;
      if (restart !== undefined && restart !== "on-failure") {
        if (
          exit.restartAttempt === undefined ||
          exit.restartAttempt > restart.max ||
          exit.restartAttempt < (previous.exit?.restartAttempt ?? 0) ||
          (exit.exhausted === true && (!completed || exit.restartAttempt !== restart.max))
        )
          continue;
      } else if (exit.restartAttempt !== undefined || exit.exhausted !== undefined) continue;
      if (
        completed &&
        !(
          (previous.spec.mode === "once" && exit.code === 0 && exit.signal === null && exit.error === undefined) ||
          (previous.spec.mode === "daemon" && exit.exhausted === true)
        )
      )
        continue;
      states.set(name, { ...previous, exit, completed });
    }
  }
  return states;
}

/** A successful once job carries an ordinary stop record, so a plain start/stop replay also leaves it stopped. */
export const recordedMonitors = (branch: readonly Entry[]): Map<string, MonitorSpec> =>
  new Map(
    [...recordedMonitorStates(branch)].flatMap(([name, record]) => (record.completed ? [] : [[name, record.spec]])),
  );
