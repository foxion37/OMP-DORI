import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { saveDeploymentJson } from "./deployment-files.ts";
import { legacyMonitorReceipts } from "./deployment-legacy-monitors.ts";
import { monitorProcessReceipts } from "./deployment-monitor-receipts.ts";
import type {
  DeploymentConfig,
  DeploymentRecord,
  MonitorProcessIdentity,
  MonitorSet,
  RuntimeIdentity,
  ToolchainReceipt,
} from "./deployment-types.ts";

export type ActiveDeployment = {
  readonly version: 1;
  readonly configHash: string;
  readonly source: string;
  readonly sourceHash: string;
  readonly runtime: RuntimeIdentity;
  readonly monitors: MonitorSet;
  readonly monitorProcesses: readonly MonitorProcessIdentity[];
  readonly legacy: boolean;
  readonly toolchain: ToolchainReceipt;
};

export function readActiveDeployment(config: DeploymentConfig): ActiveDeployment | undefined {
  try {
    return JSON.parse(readFileSync(join(config.releaseRoot, "active.json"), "utf8")) as ActiveDeployment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function saveActiveDeployment(config: DeploymentConfig, record: DeploymentRecord, rollback = false): void {
  const runtime = rollback ? record.rollbackRuntime : record.runtime;
  const toolchain = rollback ? record.oldToolchain : record.toolchain;
  if (!runtime || !record.monitors || !toolchain)
    throw new Error("active deployment has no verified runtime/toolchain");
  const legacy = rollback
    ? record.bootstrap === true
    : record.releasePath === record.oldSource && record.bootstrap === true;
  const monitorProcesses = legacy
    ? legacyMonitorReceipts(runtime.pid, record.oldMonitors ?? [])
    : monitorProcessReceipts(config, runtime, record.monitors, false);
  const active: ActiveDeployment = {
    version: 1,
    configHash: record.configHash,
    source: realpathSync(config.liveSource),
    sourceHash: rollback ? record.oldSourceHash! : record.sourceHash,
    runtime,
    monitors: record.monitors,
    monitorProcesses,
    legacy,
    toolchain,
  };
  saveDeploymentJson(join(config.releaseRoot, "active.json"), active);
}
