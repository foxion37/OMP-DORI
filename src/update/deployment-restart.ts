import { saveActiveDeployment } from "./deployment-active.ts";
import { ownReleaseRoot } from "./deployment-files.ts";
import { captureStartedMonitors } from "./deployment-handoff.ts";
import { observeDeploymentHealth, waitDeploymentHealth } from "./deployment-health.ts";
import { launchRuntime } from "./deployment-launch.ts";
import { nativeCli, stopRecordedMonitors, stopRuntime } from "./deployment-native.ts";
import { holdPendingNativeUiExit } from "./deployment-native-ui.ts";
import { acquireRestartLock, DeploymentBusy, DeploymentHeld } from "./deployment-process.ts";
import {
  deferRestartIntent,
  finishRestartIntent,
  newRestartIntent,
  readRestartIntent,
  saveRestartIntent,
} from "./deployment-restart-state.ts";
import { rollbackDeployment, waitLaunchedProcess } from "./deployment-rollback.ts";
import type { DeploymentConfig, DeploymentRecord } from "./deployment-types.ts";

/** Model-watch enters here before any signal. Interrupted restarts reconcile their durable native identity first. */
export async function restartDeployment(config: DeploymentConfig, signal?: AbortSignal): Promise<DeploymentRecord> {
  ownReleaseRoot(config);
  const releaseLock = acquireRestartLock(config);
  let record: DeploymentRecord | undefined;
  let completed = false;
  const persist = (value: DeploymentRecord): void => saveRestartIntent(config, value);
  try {
    record = readRestartIntent(config) ?? (await newRestartIntent(config, signal));
    completed = record.status === "healthy";
    if (record.status === "failed") return record;
    const cli = nativeCli(config, signal);
    if (record.status === "rolled-back" || record.step === "rollback") {
      const restored = record.status === "rolled-back" ? record : await rollbackDeployment(config, record, persist);
      restored.rollbackRuntime = await observeDeploymentHealth(
        config,
        cli,
        restored,
        restored.oldSource!,
        restored.rollbackLaunchRequestedAt ?? restored.oldRuntime!.startedAt,
        restored.bootstrap === true,
        true,
      );
      saveActiveDeployment(config, restored, true);
      persist(restored);
      finishRestartIntent(config, restored);
      return restored;
    }
    if (completed) {
      record.runtime = await observeDeploymentHealth(
        config,
        cli,
        record,
        record.releasePath,
        record.launchRequestedAt!,
        record.bootstrap === true,
      );
      saveActiveDeployment(config, record);
      persist(record);
      finishRestartIntent(config, record);
      return record;
    }
    persist(record);
    if (record.step === "prepare" || record.step === "stop") {
      record.status = "stopping";
      record.step = "stop";
      persist(record);
      await stopRuntime(config, cli, record, persist);
      await stopRecordedMonitors(config, record.oldMonitors ?? []);
      record.step = "start";
      persist(record);
    }
    if (signal?.aborted) throw new DeploymentHeld("managed restart interrupted after stop");
    if (record.step === "start") {
      record.status = "starting";
      if (!record.launchRequestedAt) {
        record.launchRequestedAt = new Date().toISOString();
        persist(record);
        await launchRuntime(config, cli, record);
      }
      const launched = await waitLaunchedProcess(config, record, record.launchRequestedAt);
      if (launched) record.launchProcess = launched;
      record.step = "health";
      persist(record);
    }
    if (!record.launchRequestedAt) throw new DeploymentHeld("managed restart launch intent is absent");
    record.runtime = await waitDeploymentHealth(
      config,
      cli,
      record,
      record.releasePath,
      record.launchRequestedAt,
      record.bootstrap === true,
      signal,
    );
    if (!record.bootstrap) record.runtimeMonitors = captureStartedMonitors(config, record);
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
    if (holdPendingNativeUiExit(record)) {
      persist(record);
      return record;
    }
    if (!completed && record.stopRequestedAt) {
      try {
        const restored = await rollbackDeployment(config, record, persist);
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
    if (error instanceof DeploymentBusy && !record.stopRequestedAt) {
      deferRestartIntent(config, record);
      throw error;
    }
    return record;
  } finally {
    releaseLock();
  }
}
