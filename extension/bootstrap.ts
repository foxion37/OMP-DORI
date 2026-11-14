import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readMonitorSet } from "../src/update/deployment-monitors.ts";
import type { IntakeSpec, MonitorSpec } from "../src/update/deployment-types.ts";
import type { DoriApi } from "./index.ts";

type Entry = { type: string; customType?: string; data?: unknown };
const BOOTSTRAP_ENTRY = "omp-dori:monitor-bootstrap";
const INTAKE_ENTRY = "omp-dori:intake";
export const MONITOR_BOOTSTRAP_FLAG = "dori-monitor-bootstrap";

/** Explicit, session-bound, private operator file. This is never inferred from an old model transcript. */
export function bootstrapMonitors(
  pi: DoriApi,
  branch: readonly Entry[],
  sessionId: string,
  previous: ReadonlyMap<string, MonitorSpec>,
): boolean {
  const path = pi.getFlag(MONITOR_BOOTSTRAP_FLAG);
  if (path === undefined) return false;
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("monitor bootstrap needs an absolute private file");
  const bootstrap = readMonitorSet(path, sessionId, true);
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (
    branch.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === BOOTSTRAP_ENTRY &&
        typeof entry.data === "object" &&
        entry.data !== null &&
        "hash" in entry.data &&
        entry.data.hash === hash,
    )
  )
    return false;
  for (const name of previous.keys()) pi.appendEntry("omp-dori:monitor", { op: "stop", name });
  for (const spec of bootstrap.monitors) pi.appendEntry("omp-dori:monitor", { op: "start", ...spec });
  pi.appendEntry(INTAKE_ENTRY, bootstrap.intake);
  pi.appendEntry(BOOTSTRAP_ENTRY, { version: 1, sessionId, hash });
  return true;
}

export function recordedIntake(branch: readonly Entry[]): IntakeSpec | undefined {
  let intake: IntakeSpec | undefined;
  for (const entry of branch) {
    if (
      entry.type !== "custom" ||
      entry.customType !== INTAKE_ENTRY ||
      typeof entry.data !== "object" ||
      entry.data === null
    )
      continue;
    const raw = entry.data as Partial<IntakeSpec>;
    if (
      typeof raw.path === "string" &&
      isAbsolute(raw.path) &&
      typeof raw.monitor === "string" &&
      typeof raw.maxAgeMs === "number" &&
      Number.isSafeInteger(raw.maxAgeMs) &&
      raw.maxAgeMs >= 100 &&
      raw.maxAgeMs <= 600_000
    )
      intake = { path: raw.path, monitor: raw.monitor, maxAgeMs: raw.maxAgeMs };
  }
  return intake;
}
