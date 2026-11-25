import { saveActiveDeployment } from "./deployment-active.ts";
import { ownReleaseRoot } from "./deployment-files.ts";
import { captureStartedMonitors } from "./deployment-handoff.ts";
import { startHarness } from "./deployment-harness.ts";
import { observeDeploymentHealth, waitDeploymentHealth } from "./deployment-health.ts";
import { acquireRestartLock, DeploymentBusy, DeploymentHeld } from "./deployment-process.ts";
import {
  deferRestartIntent,
  finishRestartIntent,
  newRestartIntent,
  readRestartIntent,
  saveRestartIntent,
} from "./deployment-restart-state.ts";
import { rollbackDeployment } from "./deployment-rollback.ts";
import { forwardStopStarted, holdPendingStop, stopRecordedMonitors, stopRuntime } from "./deployment-stop.ts";
import type { DeploymentConfig, DeploymentRecord } from "./deployment-types.ts";

/** Restart the native harness on its current source. Interrupted restarts reconcile their durable identity first. */
export async function restartDeployment(
  config: DeploymentConfig,
  signal?: AbortSignal,
  beforeForwardStop?: (record: DeploymentRecord) => Promise<void> | Promise<() => void | Promise<void>>,
): Promise<DeploymentRecord> {
  ownReleaseRoot(config);
  const releaseLock = acquireRestartLock(config);
  let record: DeploymentRecord | undefined;
  let completed = false;
  const persist = (value: DeploymentRecord): void => saveRestartIntent(config, value);
  try {
    record = readRestartIntent(config) ?? (await newRestartIntent(config, signal));
    completed = record.status === "healthy";
    if (record.status === "failed") return record;
    if (record.status === "rolled-back" || record.step === "rollback") {
      const restored =
        record.status === "rolled-back" ? record : await rollbackDeployment(config, record, persist, signal);
      restored.rollbackRuntime = await observeDeploymentHealth(
        config,
        restored,
        restored.oldSource!,
        restored.rollbackLaunchRequestedAt ?? restored.oldRuntime!.startedAt,
        true,
      );
      saveActiveDeployment(config, restored, true);
      persist(restored);
      finishRestartIntent(config, restored);
      return restored;
    }
    if (completed) {
      record.runtime = await observeDeploymentHealth(config, record, record.releasePath, record.launchRequestedAt!);
      saveActiveDeployment(config, record);
      persist(record);
      finishRestartIntent(config, record);
      return record;
    }
    persist(record);
    if (record.step === "prepare" || record.step === "stop") {
      const admission = !forwardStopStarted(record) ? await beforeForwardStop?.(record) : undefined;
      record.status = "stopping";
      record.step = "stop";
      persist(record);
      await stopRuntime(
        config,
        record,
        persist,
        false,
        typeof admission === "function" ? admission : undefined,
        signal,
      );
      await stopRecordedMonitors(config, record.oldMonitors ?? []);
      record.step = "start";
      persist(record);
    }
    if (signal?.aborted) throw new DeploymentHeld("managed restart interrupted after stop");
    if (record.step === "start") {
      record.status = "starting";
      record.launchRequestedAt ??= new Date().toISOString();
      persist(record);
      const { cwd, sessionId } = record.oldRuntime!;
      await startHarness(config, record.releasePath, record.toolchain!, cwd, sessionId, signal);
      record.step = "health";
      persist(record);
    }
    if (!record.launchRequestedAt) throw new DeploymentHeld("managed restart launch intent is absent");
    record.runtime = await waitDeploymentHealth(config, record, record.releasePath, record.launchRequestedAt, signal);
    record.runtimeMonitors = await captureStartedMonitors(config, record);
    record.status = "healthy";
    record.step = "done";
    record.healthyAt = new Date().toISOString();
    saveActiveDeployment(config, record);
    persist(record);
    finishRestartIntent(config, record);
    return record;
  } catch (error) {
    if (!record) throw error;
    record.error = error instanceof DeploymentHeld ? error.message : "managed restart failed";
    if (holdPendingStop(record)) {
      persist(record);
      return record;
    }
    if (!completed && forwardStopStarted(record)) {
      try {
        const restored = await rollbackDeployment(config, record, persist, signal);
        saveActiveDeployment(config, restored, true);
        finishRestartIntent(config, restored);
        return restored;
      } catch (rollbackError) {
        record.status = "failed";
        record.rollbackError =
          rollbackError instanceof DeploymentHeld
            ? rollbackError.message
            : "managed restart did not restore verified service";
      }
    } else record.status = "held";
    persist(record);
    if (error instanceof DeploymentBusy && !forwardStopStarted(record)) {
      deferRestartIntent(config, record);
      throw error;
    }
    return record;
  } finally {
    releaseLock();
  }
}
