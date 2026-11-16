import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentCli } from "./deployment-cli.ts";
import { launchedProcess } from "./deployment-launch.ts";
import {
  type LegacyRollbackForeground,
  completedLegacyRollbackForeground,
  legacyMonitorReceipts,
  legacyRollbackForeground,
} from "./deployment-legacy-monitors.ts";
import { readRuntimeHealth } from "./deployment-monitor-receipts.ts";
import { captureRuntime } from "./deployment-native.ts";
import { readMonitorSet, sameMonitorSpecs } from "./deployment-monitors.ts";
import { runtimeUsesToolchain } from "./deployment-prior.ts";
import { DeploymentHeld, processIdentity, sameProcess, underProcess } from "./deployment-process.ts";
import { assertRuntimeToolchain } from "./deployment-toolchain.ts";
import type { DeploymentConfig, DeploymentRecord, RuntimeIdentity } from "./deployment-types.ts";
import { digest, sourceManifest } from "./source.ts";

export async function observeDeploymentHealth(
  config: DeploymentConfig,
  cli: DeploymentCli,
  record: DeploymentRecord,
  source: string,
  since: string,
  legacy = false,
  prior = false,
): Promise<RuntimeIdentity> {
  let rollback: LegacyRollbackForeground | undefined;
  if (legacy && prior && record.rollbackLaunchRequestedAt === since) {
    const expected = record.rollbackProcess;
    if (!expected) throw new DeploymentHeld("rollback health has no journaled launch identity");
    const actual = await launchedProcess(config, cli, record, since, true);
    if (!actual || !sameProcess(expected, actual))
      throw new DeploymentHeld("rollback launch identity differs before health observation");
    const attestRollback =
      record.status === "rolled-back" || record.step === "done"
        ? completedLegacyRollbackForeground
        : legacyRollbackForeground;
    rollback = attestRollback(config, record, since, expected);
  }
  const runtime = await captureRuntime(config, cli, true, undefined, rollback);
  const sinceMs = Date.parse(since);
  if (
    !Number.isFinite(sinceMs) ||
    !record.monitors ||
    runtime.sessionFile !== record.oldRuntime?.sessionFile ||
    Date.parse(runtime.startedAt) < sinceMs
  )
    throw new DeploymentHeld("resumed native session identity differs");
  if (realpathSync(config.liveSource) !== realpathSync(source))
    throw new DeploymentHeld("running source pointer differs");
  if (legacy) {
    if (!record.oldMonitors) throw new DeploymentHeld("legacy monitor identity receipts are absent");
    if (!rollback) legacyMonitorReceipts(runtime.pid, record.oldMonitors);
  } else {
    const health = readRuntimeHealth(config);
    if (
      !health ||
      !health.presetLoaded ||
      health.pid !== runtime.pid ||
      health.startedAt !== runtime.startedAt ||
      realpathSync(health.source) !== realpathSync(source) ||
      Date.parse(health.updatedAt) < sinceMs ||
      Date.now() - Date.parse(health.updatedAt) > 5_000 ||
      health.extensionHash !== digest(readFileSync(join(source, "extension/index.ts"))) ||
      !sameMonitorSpecs(health.monitors, record.monitors.monitors)
    )
      throw new DeploymentHeld("native code or desired monitor health has not converged");
    const desired = readMonitorSet(
      join(config.stateDir, "monitors", `${encodeURIComponent(config.sessionId)}.json`),
      config.sessionId,
    );
    if (
      !sameMonitorSpecs(desired.monitors, record.monitors.monitors) ||
      JSON.stringify(desired.intake) !== JSON.stringify(record.monitors.intake)
    )
      throw new DeploymentHeld("restored desired monitor state differs");
    for (const monitor of health.monitors) {
      const current = processIdentity(monitor.pid);
      if (
        !current ||
        monitor.pid === runtime.pid ||
        current.startTicks !== monitor.startTicks ||
        !underProcess(monitor.pid, runtime.pid)
      )
        throw new DeploymentHeld("monitor PID ownership differs");
    }
  }
  const intake = record.monitors.intake;
  const pulse = lstatSync(intake.path);
  if (
    !pulse.isFile() ||
    pulse.isSymbolicLink() ||
    (pulse.mode & 0o022) !== 0 ||
    (process.getuid !== undefined && pulse.uid !== process.getuid())
  )
    throw new DeploymentHeld("intake heartbeat ownership differs");
  const at = Number(readFileSync(intake.path, "utf8").trim());
  if (
    !Number.isSafeInteger(at) ||
    at < sinceMs ||
    pulse.mtimeMs < sinceMs ||
    at > Date.now() + 1_000 ||
    Date.now() - at > intake.maxAgeMs
  )
    throw new DeploymentHeld("fresh inbound heartbeat has not arrived");
  const expectedHash =
    realpathSync(source) === realpathSync(record.releasePath) ? record.sourceHash : record.oldSourceHash;
  if (sourceManifest(realpathSync(source)).hash !== expectedHash)
    throw new DeploymentHeld("running source bytes differ");
  const toolchain = prior ? record.oldToolchain : record.toolchain;
  if (!toolchain || !runtimeUsesToolchain(runtime, toolchain))
    throw new DeploymentHeld("running native image differs from its receipt");
  assertRuntimeToolchain(config, toolchain);
  if (record.oldRuntime && !sameProcess(record.oldRuntime, runtime)) {
    const actual = await launchedProcess(config, cli, record, since, prior);
    if (!actual || !sameProcess(runtime, actual))
      throw new DeploymentHeld("managed native launch argv or executable differs");
  }
  if (!sameProcess(runtime)) throw new DeploymentHeld("native runtime changed during health observation");
  return { ...runtime, nativeVersion: toolchain.nativeVersion, entrypointHash: toolchain.ompEntryHash };
}

export async function waitDeploymentHealth(
  config: DeploymentConfig,
  cli: DeploymentCli,
  record: DeploymentRecord,
  source: string,
  since: string,
  legacy = false,
  signal?: AbortSignal,
  prior = false,
): Promise<RuntimeIdentity> {
  const deadline = Date.now() + config.healthTimeoutMs;
  do {
    if (signal?.aborted) throw new DeploymentHeld("deployment health observation interrupted");
    try {
      return await observeDeploymentHealth(config, cli, record, source, since, legacy, prior);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await Bun.sleep(250);
  } while (Date.now() <= deadline);
  throw new DeploymentHeld("deployment health deadline elapsed");
}
