import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isCatalyEntry, SESSION_WIRE } from "../skills/cataly-mode/scripts/src/session-compat.ts";
import { readMonitorSet } from "../src/update/deployment-monitors.ts";
import type { IntakeSpec, MonitorSpec } from "../src/update/deployment-types.ts";
import type { CatalyApi } from "./index.ts";

type Entry = { type: string; customType?: string; data?: unknown };
const BOOTSTRAP_ENTRY = "omp-cataly:monitor-bootstrap";
const INTAKE_ENTRY = "omp-cataly:intake";
export const MONITOR_BOOTSTRAP_FLAG = "cataly-monitor-bootstrap";

/** Explicit, session-bound, private operator file. This is never inferred from an old model transcript. */
export function bootstrapMonitors(
  pi: CatalyApi,
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
        isCatalyEntry(entry.customType, BOOTSTRAP_ENTRY) &&
        typeof entry.data === "object" &&
        entry.data !== null &&
        "hash" in entry.data &&
        entry.data.hash === hash,
    )
  )
    return false;
  for (const name of previous.keys()) pi.appendEntry(SESSION_WIRE.monitor, { op: "stop", name });
  for (const spec of bootstrap.monitors) pi.appendEntry(SESSION_WIRE.monitor, { op: "start", ...spec });
  pi.appendEntry(SESSION_WIRE.intake, bootstrap.intake);
  pi.appendEntry(SESSION_WIRE.monitorBootstrap, { version: 1, sessionId, hash });
  return true;
}

export function recordedIntake(branch: readonly Entry[]): IntakeSpec | undefined {
  let intake: IntakeSpec | undefined;
  for (const entry of branch) {
    if (
      entry.type !== "custom" ||
      !isCatalyEntry(entry.customType, INTAKE_ENTRY) ||
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
