import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readActiveDeployment } from "./deployment-active.ts";
import { capturePointer, saveDeploymentJson } from "./deployment-files.ts";
import { legacyMonitorReceipts } from "./deployment-legacy-monitors.ts";
import { monitorProcessReceipts, readRuntimeHealth } from "./deployment-monitor-receipts.ts";
import { readMonitorSet } from "./deployment-monitors.ts";
import { captureRuntime, nativeCli } from "./deployment-native.ts";
import { admitRuntimeToolchains } from "./deployment-prior.ts";
import {
  actorEnv,
  DeploymentBusy,
  DeploymentHeld,
  processIdentity,
  sameProcess,
  underProcess,
} from "./deployment-process.ts";
import type {
  DeploymentConfig,
  DeploymentRecord,
  MonitorProcessIdentity,
  RuntimeIdentity,
} from "./deployment-types.ts";
import { digest, sourceManifest } from "./source.ts";
import { procCmdline } from "./proc.ts";

export function prepareLauncher(config: DeploymentConfig, record: DeploymentRecord): string {
  const manifest = sourceManifest(record.releasePath);
  for (const shim of config.shims) {
    if (
      shim.source !== "." &&
      !manifest.files.some((file) => file.path === shim.source || file.path.startsWith(`${shim.source}/`))
    )
      throw new DeploymentHeld("configured shim target is outside admitted release source");
  }
  const configPath = join(record.directory, "config.json");
  saveDeploymentJson(configPath, config);
  const path = join(record.directory, "managed-restart.sh");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  // Fixed controller code remains available even if the stable source pointer rolls back to a legacy checkout.
  const environment = Object.entries(actorEnv(config))
    .map(([key, value]) => quote(`${key}=${value}`))
    .join(" ");
  const launcher = `#!/bin/sh\ncd ${quote(record.directory)} || exit 2\nexec /usr/bin/env -i ${environment} ${quote(config.bun)} ${quote(join(record.releasePath, "src/update/deployment-launcher.ts"))} ${quote(configPath)} "$@"\n`;
  writeFileSync(path, launcher, { mode: 0o755 });
  return path;
}

export async function captureHandoff(
  config: DeploymentConfig,
  record: DeploymentRecord,
  launcher?: string,
): Promise<RuntimeIdentity> {
  const runtime = await captureRuntime(config, nativeCli(config), true);
  if (runtime.approvalPending) throw new DeploymentHeld("native Dori has an approval; deployment is held");
  if (!launcher && runtime.busy) throw new DeploymentBusy("managed restart waits for the native idle boundary");
  const health = readRuntimeHealth(config);
  const bootstrap = !health || health.pid !== runtime.pid || health.startedAt !== runtime.startedAt;
  if (bootstrap && !config.monitorBootstrapFile)
    throw new DeploymentHeld("first legacy handoff needs trusted monitor bootstrap");
  const monitors = bootstrap
    ? readMonitorSet(config.monitorBootstrapFile!, config.sessionId, true)
    : readMonitorSet(
        join(config.stateDir, "monitors", `${encodeURIComponent(config.sessionId)}.json`),
        config.sessionId,
      );
  record.oldSource = realpathSync(config.liveSource);
  record.oldSourceHash = sourceManifest(record.oldSource).hash;
  if (
    !bootstrap &&
    (!health ||
      !health.presetLoaded ||
      realpathSync(health.source) !== record.oldSource ||
      health.extensionHash !== digest(readFileSync(join(record.oldSource, "extension/index.ts"))))
  )
    throw new DeploymentHeld("prior native loaded code differs from its source pointer");
  const active = readActiveDeployment(config);
  const priorRuntime = await admitRuntimeToolchains(config, record, runtime, active, launcher !== undefined);
  record.oldMonitors =
    bootstrap &&
    active?.configHash === record.configHash &&
    active.sourceHash === record.oldSourceHash &&
    active.runtime.sessionId === runtime.sessionId &&
    active.runtime.sessionFile === runtime.sessionFile &&
    active.runtime.startedAt === runtime.startedAt &&
    sameProcess(active.runtime, runtime)
      ? legacyMonitorReceipts(runtime.pid, active.monitorProcesses)
      : monitorProcessReceipts(config, runtime, monitors, bootstrap);
  record.monitors = monitors;
  record.bootstrap = bootstrap;
  record.oldRuntime = priorRuntime;
  if (launcher)
    record.pointers = [
      capturePointer(config.liveSource, record.releasePath, record.id),
      ...config.shims.map((shim) => capturePointer(shim.path, join(config.liveSource, shim.source), record.id)),
      capturePointer(config.launcherPath, launcher, record.id),
    ];
  return priorRuntime;
}

/** Capture only observed monitor children, including a partially restored set after failed startup. */
export function captureStartedMonitors(
  config: DeploymentConfig,
  record: DeploymentRecord,
): readonly MonitorProcessIdentity[] {
  const root = record.runtime ?? record.launchProcess;
  if (!root || !sameProcess(root)) return record.runtimeMonitors ?? [];
  const health = readRuntimeHealth(config);
  if (!health || health.pid !== root.pid) return record.runtimeMonitors ?? [];
  return health.monitors.map((monitor) => {
    const identity = processIdentity(monitor.pid);
    if (
      !identity ||
      monitor.pid === root.pid ||
      identity.startTicks !== monitor.startTicks ||
      !underProcess(monitor.pid, root.pid)
    )
      throw new DeploymentHeld("started monitor ownership differs");
    const argv = procCmdline(monitor.pid).split("\0").filter(Boolean);
    return { ...identity, name: monitor.name, argv };
  });
}
