import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readActiveDeployment } from "./deployment-active.ts";
import { capturePointer, saveDeploymentJson } from "./deployment-files.ts";
import { captureRuntime } from "./deployment-harness.ts";
import { leadRuntimeHealth, monitorProcessReceipts } from "./deployment-monitor-receipts.ts";
import { admitRuntimeToolchains } from "./deployment-prior.ts";
import { actorEnv, DeploymentBusy, DeploymentHeld, sameProcess } from "./deployment-process.ts";
import type {
  DeploymentConfig,
  DeploymentRecord,
  MonitorProcessIdentity,
  RuntimeHealth,
  RuntimeIdentity,
} from "./deployment-types.ts";
import { digest, sourceManifest } from "./source.ts";

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
  // Fixed controller code remains available even if the stable source pointer rolls back.
  const environment = Object.entries(actorEnv(config))
    .map(([key, value]) => quote(`${key}=${value}`))
    .join(" ");
  const launcher = `#!/bin/sh\ncd ${quote(record.directory)} || exit 2\nexec /usr/bin/env -i ${environment} ${quote(config.bun)} ${quote(join(record.releasePath, "src/update/deployment-launcher.ts"))} ${quote(configPath)} "$@"\n`;
  writeFileSync(path, launcher, { mode: 0o755 });
  return path;
}

/** Fresh health from this lead's extension, loaded from `source`. */
export function convergedHealth(
  config: DeploymentConfig,
  runtime: RuntimeIdentity,
  source: string,
  since = Number.NEGATIVE_INFINITY,
): RuntimeHealth {
  const health = leadRuntimeHealth(config.stateDir, runtime);
  if (
    !health ||
    !health.configLoaded ||
    realpathSync(health.source) !== realpathSync(source) ||
    Date.parse(health.updatedAt) < since ||
    Date.now() - Date.parse(health.updatedAt) > 5_000 ||
    health.extensionHash !== digest(readFileSync(join(source, "extension/index.ts")))
  )
    throw new DeploymentHeld("native lead code health has not converged on its source");
  return health;
}

export async function captureHandoff(
  config: DeploymentConfig,
  record: DeploymentRecord,
  launcher?: string,
): Promise<RuntimeIdentity> {
  const runtime = await captureRuntime(config, true);
  if (runtime.approvalPending) throw new DeploymentHeld("native Cataly has an approval; deployment is held");
  if (!launcher && runtime.busy) throw new DeploymentBusy("managed restart waits for the native idle boundary");
  record.oldSource = realpathSync(config.liveSource);
  record.oldSourceHash = sourceManifest(record.oldSource).hash;
  const health = convergedHealth(config, runtime, record.oldSource);
  const priorRuntime = await admitRuntimeToolchains(
    config,
    record,
    runtime,
    readActiveDeployment(config),
    launcher !== undefined,
  );
  record.oldMonitors = monitorProcessReceipts(runtime, health);
  record.oldRuntime = priorRuntime;
  if (launcher)
    record.pointers = [
      capturePointer(config.liveSource, record.releasePath, record.id),
      ...config.shims.map((shim) => capturePointer(shim.path, join(config.liveSource, shim.source), record.id)),
      capturePointer(config.launcherPath, launcher, record.id),
    ];
  return priorRuntime;
}

/** Capture only observed monitor children of the started lead, including a partially restored set. */
export async function captureStartedMonitors(
  config: DeploymentConfig,
  record: DeploymentRecord,
): Promise<readonly MonitorProcessIdentity[]> {
  let root = record.runtime;
  if (!root) {
    try {
      root = await captureRuntime(config, true);
    } catch (error) {
      if (!(error instanceof DeploymentHeld)) throw error;
    }
  }
  const health = root && sameProcess(root) ? leadRuntimeHealth(config.stateDir, root) : undefined;
  return root && health ? monitorProcessReceipts(root, health) : (record.runtimeMonitors ?? []);
}
