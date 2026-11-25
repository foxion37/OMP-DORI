import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCatalyRole } from "../../skills/cataly-mode/scripts/src/session-compat.ts";
import { DeploymentHeld, processIdentity, sameProcess, underProcess } from "./deployment-process.ts";
import { currentHealth } from "./deployment-previous-main.ts";
import type { MonitorProcessIdentity, RuntimeHealth, RuntimeIdentity } from "./deployment-types.ts";
import { procCmdline } from "./proc.ts";

/** `pane` is the writer's session address: the lead's headless reservation id. */
export function readRuntimeHealth(config: {
  readonly stateDir: string;
  readonly pane: string;
  readonly sessionId: string;
}): RuntimeHealth | undefined {
  const path = join(config.stateDir, "runtime", `${encodeURIComponent(config.pane)}.json`);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || (stat.mode & 0o022) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid()))
    throw new DeploymentHeld("runtime health ownership differs");
  const value = currentHealth(JSON.parse(readFileSync(path, "utf8"))) as RuntimeHealth;
  if (
    value.version !== 1 ||
    !Array.isArray(value.monitors) ||
    value.paneId !== config.pane ||
    value.sessionId !== config.sessionId ||
    parseCatalyRole(value.role) !== "cataly" ||
    typeof value.configLoaded !== "boolean" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    Date.parse(value.updatedAt) < Date.parse(value.startedAt) ||
    Date.parse(value.updatedAt) > Date.now() + 1_000
  )
    throw new DeploymentHeld("runtime health schema differs");
  return { ...value, role: "cataly" };
}

/** The lead's runtime health, written by its own loaded extension for this exact process and reservation. */
export function leadRuntimeHealth(stateDir: string, runtime: RuntimeIdentity): RuntimeHealth | undefined {
  const health = readRuntimeHealth({ stateDir, pane: runtime.ref, sessionId: runtime.sessionId });
  return health?.pid === runtime.pid && health.startedAt === runtime.startedAt ? health : undefined;
}

/** Bind every monitor the lead's health reports to one live child incarnation of the lead. */
export function monitorProcessReceipts(
  runtime: RuntimeIdentity,
  health: RuntimeHealth,
): readonly MonitorProcessIdentity[] {
  if (health.pid !== runtime.pid || health.sessionId !== runtime.sessionId || !sameProcess(runtime))
    throw new DeploymentHeld("monitor writer differs from native runtime");
  if (new Set(health.monitors.map(({ pid }) => pid)).size !== health.monitors.length)
    throw new DeploymentHeld("monitor PID receipts are ambiguous");
  const receipts = health.monitors.map(({ name, pid, startTicks }) => {
    const identity = processIdentity(pid);
    if (
      !identity ||
      pid === runtime.pid ||
      identity.bootId !== runtime.bootId ||
      identity.startTicks !== startTicks ||
      !underProcess(pid, runtime.pid)
    )
      throw new DeploymentHeld("monitor is no longer owned by target runtime");
    const argv = procCmdline(pid).split("\0").filter(Boolean);
    if (!sameProcess(identity)) throw new DeploymentHeld("monitor PID changed during capture");
    return { ...identity, name, argv };
  });
  if (!sameProcess(runtime)) throw new DeploymentHeld("native PID changed during monitor capture");
  return receipts;
}
