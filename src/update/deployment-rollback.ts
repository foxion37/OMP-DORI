import type { DeploymentCli } from "./deployment-cli.ts";
import { restorePointer } from "./deployment-files.ts";
import { captureStartedMonitors } from "./deployment-handoff.ts";
import { observeDeploymentHealth, waitDeploymentHealth } from "./deployment-health.ts";
import { launchedProcess, launchRuntime, stopLaunchedProcess } from "./deployment-launch.ts";
import { nativeCli, requireShell, stopRecordedMonitors } from "./deployment-native.ts";
import { DeploymentHeld, sameProcess } from "./deployment-process.ts";
import type { DeploymentConfig, DeploymentRecord, ProcessIdentity } from "./deployment-types.ts";

export async function waitLaunchedProcess(
  config: DeploymentConfig,
  record: DeploymentRecord,
  since: string,
  prior = false,
  options: { cli?: DeploymentCli; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProcessIdentity | undefined> {
  if (!record.oldRuntime) throw new DeploymentHeld("launch has no previous native identity");
  const cli = options.cli ?? nativeCli(config, options.signal);
  const deadline = Date.now() + (options.timeoutMs ?? Math.min(config.healthTimeoutMs, 10_000));
  let held: DeploymentHeld | undefined;
  do {
    if (options.signal?.aborted) throw new DeploymentHeld("launch observation interrupted");
    try {
      const identity = await launchedProcess(config, cli, record, since, prior);
      if (options.signal?.aborted) throw new DeploymentHeld("launch observation interrupted");
      if (identity) return identity;
      held = undefined;
    } catch (error) {
      if (!(error instanceof DeploymentHeld) || options.signal?.aborted) throw error;
      held = error;
    }
    await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  if (held) throw held;
  return undefined;
}

/** The previous source and exact old links remain owned rollback material; none are deleted or copied over state. */
export async function rollbackDeployment(
  config: DeploymentConfig,
  record: DeploymentRecord,
  persist: (record: DeploymentRecord) => void,
): Promise<DeploymentRecord> {
  if (!record.oldRuntime || !record.oldSource || !record.oldSourceHash || !record.monitors)
    throw new DeploymentHeld("rollback lacks the pre-effect handoff journal");
  const cli = nativeCli(config);
  if (record.status === "rolled-back" && record.step === "done") {
    const expected = record.rollbackRuntime;
    if (!expected || !record.rollbackHealthyAt)
      throw new DeploymentHeld("completed rollback lacks healthy runtime receipts");
    const runtime = await waitDeploymentHealth(
      config,
      cli,
      record,
      record.oldSource,
      record.rollbackLaunchRequestedAt ?? record.oldRuntime.startedAt,
      record.bootstrap === true,
      undefined,
      true,
    );
    if (!sameProcess(expected, runtime) || expected.sessionId !== runtime.sessionId)
      throw new DeploymentHeld("completed rollback runtime differs from its receipt");
    return record;
  }
  record.step = "rollback";
  record.rollbackRequestedAt ??= new Date().toISOString();
  persist(record);
  if (sameProcess(record.oldRuntime)) {
    for (const pointer of [...(record.pointers ?? [])].reverse()) restorePointer(pointer);
    record.rollbackRuntime = await observeDeploymentHealth(
      config,
      cli,
      record,
      record.oldSource,
      record.oldRuntime.startedAt,
      record.bootstrap === true,
      true,
    );
  } else {
    if (!record.rollbackLaunchRequestedAt) {
      if (!record.launchProcess && record.launchRequestedAt) {
        const found = await waitLaunchedProcess(config, record, record.launchRequestedAt, false, {
          cli,
          timeoutMs: config.stopTimeoutMs,
        });
        if (found) {
          record.launchProcess = found;
          persist(record);
        }
      }
      if (record.launchProcess && record.launchRequestedAt) {
        record.runtimeMonitors = captureStartedMonitors(config, record);
        persist(record);
        await stopLaunchedProcess(config, cli, record, record.launchRequestedAt, record.launchProcess);
        await stopRecordedMonitors(config, record.runtimeMonitors);
      } else await requireShell(config, cli);
      await stopRecordedMonitors(config, record.oldMonitors ?? []);
      for (const pointer of [...(record.pointers ?? [])].reverse()) restorePointer(pointer);
      record.rollbackLaunchRequestedAt = new Date().toISOString();
      persist(record);
      // Legacy extensions restore compatible persisted starts without the new bootstrap flag.
      await launchRuntime(config, cli, record, false, true);
    } else if (!record.rollbackProcess) {
      const observed = await waitLaunchedProcess(config, record, record.rollbackLaunchRequestedAt, true);
      if (observed) {
        record.rollbackProcess = observed;
        persist(record);
      } else {
        await requireShell(config, cli);
        record.rollbackLaunchRequestedAt = new Date().toISOString();
        persist(record);
        await launchRuntime(config, cli, record, false, true);
      }
    }
    if (!record.rollbackProcess) {
      const found = await waitLaunchedProcess(config, record, record.rollbackLaunchRequestedAt, true);
      if (found) {
        record.rollbackProcess = found;
        persist(record);
      }
    }
    if (!record.rollbackProcess) throw new DeploymentHeld("rollback native launch identity is unavailable");
    record.rollbackRuntime = await waitDeploymentHealth(
      config,
      cli,
      record,
      record.oldSource,
      record.rollbackLaunchRequestedAt,
      record.bootstrap === true,
      undefined,
      true,
    );
  }
  record.status = "rolled-back";
  record.step = "done";
  record.rollbackHealthyAt = new Date().toISOString();
  persist(record);
  return record;
}
