import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { saveActiveDeployment } from "./deployment-active.ts";
import { ownReleaseRoot, saveDeploymentJson, switchPointer } from "./deployment-files.ts";
import { captureHandoff, captureStartedMonitors, prepareLauncher } from "./deployment-handoff.ts";
import { observeDeploymentHealth, waitDeploymentHealth } from "./deployment-health.ts";
import { assertPreparedLayout, refreshBusyHandoff, verifyBusyHold } from "./deployment-hold.ts";
import { launchRuntime } from "./deployment-launch.ts";
import { waitForRestartLock } from "./deployment-lock.ts";
import { assertRetryDeadline, nativeCli, stopRecordedMonitors, stopRuntime } from "./deployment-native.ts";
import { holdPendingNativeUiExit } from "./deployment-native-ui.ts";
import { prepareRelease, validateDeploymentInput } from "./deployment-prepare.ts";
import { acquireRestartLock, DeploymentBusy, DeploymentHeld, DeploymentRetryable } from "./deployment-process.ts";
import { restartDeployment } from "./deployment-restart.ts";
import { readRestartIntent } from "./deployment-restart-state.ts";
import { rollbackDeployment, waitLaunchedProcess } from "./deployment-rollback.ts";
import type { DeploymentConfig, DeploymentInput, DeploymentRecord } from "./deployment-types.ts";
import { digest } from "./source.ts";

/** Preparation/publication identity is immutable. Runtime effects have their own independently resumable journal. */
export async function deployRelease(
  config: DeploymentConfig,
  input: DeploymentInput,
  previous: DeploymentRecord | undefined,
  persist: (record: DeploymentRecord) => void,
  signal?: AbortSignal,
  beforeForwardStop?: (record: DeploymentRecord) => Promise<void>,
): Promise<DeploymentRecord> {
  const inputHash = digest(JSON.stringify(input));
  const configHash = digest(JSON.stringify(config));
  const id = previous?.id ?? randomUUID();
  const record: DeploymentRecord = previous ?? {
    version: 1,
    id,
    inputHash,
    configHash,
    commit: input.commit,
    tree: input.tree,
    sourceHash: input.sourceHash,
    releasePath: join(config.releaseRoot, "releases", `${input.commit}-${input.sourceHash.slice(0, 16)}`),
    directory: join(config.releaseRoot, "transactions", id),
    createdAt: new Date().toISOString(),
    status: "prepared",
    step: "prepare",
  };
  let current = record;
  let releaseLock: (() => void) | undefined;
  let completed = current.status === "healthy";
  let retryingHandoff = current.status === "held" && current.retryableHold === true && current.oldRuntime !== undefined;
  delete current.retryableHold;
  const save = (value: DeploymentRecord): void => {
    saveDeploymentJson(join(value.directory, "deployment.json"), value);
    persist(value);
  };
  const resume = (): void => {
    const journal = join(current.directory, "deployment.json");
    if (!previous || !lstatSync(journal, { throwIfNoEntry: false })) return;
    const durable = JSON.parse(readFileSync(journal, "utf8")) as DeploymentRecord;
    if (
      durable.id !== id ||
      durable.inputHash !== inputHash ||
      durable.configHash !== configHash ||
      durable.directory !== current.directory ||
      durable.releasePath !== current.releasePath
    )
      throw new DeploymentHeld("durable deployment intent differs");
    const deadline = current.retryDeadlineAt;
    if (
      deadline !== undefined &&
      (durable.retryDeadlineAt === undefined ||
        !Number.isFinite(Date.parse(deadline)) ||
        Date.parse(deadline) < Date.parse(durable.retryDeadlineAt))
    )
      durable.retryDeadlineAt = deadline;
    current = durable;
    completed = current.status === "healthy";
    retryingHandoff = current.status === "held" && current.retryableHold === true && current.oldRuntime !== undefined;
    delete current.retryableHold;
  };
  try {
    if (
      !/^[A-Za-z0-9-]+$/.test(id) ||
      current.inputHash !== inputHash ||
      current.configHash !== configHash ||
      current.directory !== join(config.releaseRoot, "transactions", id) ||
      current.releasePath !== join(config.releaseRoot, "releases", `${input.commit}-${input.sourceHash.slice(0, 16)}`)
    )
      throw new DeploymentHeld("deployment journal identity differs");
    ownReleaseRoot(config);
    resume();
    assertRetryDeadline(current);
    await waitForRestartLock(config, signal);
    assertRetryDeadline(current);
    if (readRestartIntent(config)) {
      try {
        const recovered = await restartDeployment(config, signal);
        if (recovered.status !== "healthy")
          throw new DeploymentHeld("pending managed restart needs review before rollout");
      } catch (error) {
        if (!(error instanceof DeploymentBusy)) throw error;
      }
    }
    releaseLock = acquireRestartLock(config);
    resume();
    assertRetryDeadline(current);
    if (current.status === "healthy") {
      if (!current.launchRequestedAt) throw new DeploymentHeld("healthy deployment has no launch receipt");
      current.runtime = await observeDeploymentHealth(
        config,
        nativeCli(config, signal),
        current,
        current.releasePath,
        current.launchRequestedAt,
      );
      current.healthyAt = new Date().toISOString();
      saveActiveDeployment(config, current);
      save(current);
      return current;
    }
    if (current.status === "rolled-back" || current.status === "failed") return current;
    if (current.step === "rollback") {
      const rolledBack = await rollbackDeployment(config, current, save);
      saveActiveDeployment(config, rolledBack, true);
      return rolledBack;
    }
    if (signal?.aborted) throw new DeploymentHeld("deployment interrupted before effects");
    if (!current.preparedAt) {
      save(current);
      await prepareRelease(config, input, current, signal);
      current.preparedAt = new Date().toISOString();
      save(current);
    } else validateDeploymentInput(input);
    if ((retryingHandoff || current.step === "stop") && !current.stopRequestedAt && !current.quiesceHash) {
      await refreshBusyHandoff(config, current);
      save(current);
    }
    if (!current.oldRuntime) {
      const launcher = prepareLauncher(config, current);
      await captureHandoff(config, current, launcher);
      save(current);
    }
    const cli = nativeCli(config, signal);
    if (current.step === "prepare" || current.step === "stop") {
      if (!current.stopRequestedAt) assertPreparedLayout(config, current);
      if (!current.stopRequestedAt) await beforeForwardStop?.(current);
      current.status = "stopping";
      current.step = "stop";
      save(current);
      await stopRuntime(config, cli, current, save, true);
      await stopRecordedMonitors(config, current.oldMonitors ?? []);
      current.step = "switch";
      save(current);
    }
    if (signal?.aborted) throw new DeploymentHeld("deployment interrupted after stop");
    if (current.step === "switch") {
      current.status = "switching";
      save(current);
      for (const pointer of current.pointers ?? []) switchPointer(pointer);
      current.step = "start";
      save(current);
    }
    if (current.step === "start") {
      current.status = "starting";
      if (!current.launchRequestedAt) {
        current.launchRequestedAt = new Date().toISOString();
        save(current);
        await launchRuntime(config, cli, current, current.bootstrap === true);
      }
      const identity = await waitLaunchedProcess(config, current, current.launchRequestedAt);
      if (identity) current.launchProcess = identity;
      current.step = "health";
      save(current);
    }
    if (!current.launchRequestedAt) throw new DeploymentHeld("deployment launch intent is absent");
    current.runtime = await waitDeploymentHealth(
      config,
      cli,
      current,
      current.releasePath,
      current.launchRequestedAt,
      false,
      signal,
    );
    current.runtimeMonitors = captureStartedMonitors(config, current);
    current.status = "healthy";
    current.step = "done";
    current.healthyAt = new Date().toISOString();
    delete current.error;
    saveActiveDeployment(config, current);
    save(current);
    return current;
  } catch (error) {
    current.error = error instanceof DeploymentHeld ? error.message : "release preparation or native startup failed";
    if (holdPendingNativeUiExit(current)) {
      current.retryableHold = true;
      if (releaseLock) save(current);
      else persist(current);
      return current;
    }
    if (!completed && releaseLock && current.stopRequestedAt && current.oldRuntime) {
      try {
        const rolledBack = await rollbackDeployment(config, current, save);
        saveActiveDeployment(config, rolledBack, true);
        return rolledBack;
      } catch (rollbackError) {
        current.status = "failed";
        current.rollbackError =
          rollbackError instanceof DeploymentHeld ? rollbackError.message : "rollback did not restore verified service";
      }
    } else current.status = !current.stopRequestedAt || error instanceof DeploymentHeld ? "held" : "failed";
    if (error instanceof DeploymentBusy && releaseLock && !current.stopRequestedAt) {
      try {
        await verifyBusyHold(config, current);
        current.retryableHold = true;
        delete current.retryDeadlineAt;
      } catch (validationError) {
        current.error =
          validationError instanceof DeploymentHeld ? validationError.message : "busy handoff could not be verified";
      }
    }
    if (
      error instanceof DeploymentRetryable &&
      !current.stopRequestedAt &&
      (current.step === "prepare" || current.step === "stop")
    ) {
      current.retryableHold = true;
      current.retryDeadlineAt ??= new Date(Date.now() + 3_600_000).toISOString();
      try {
        assertRetryDeadline(current);
      } catch (deadlineError) {
        delete current.retryableHold;
        current.error = (deadlineError as Error).message;
      }
    }
    if (releaseLock) save(current);
    else persist(current);
    return current;
  } finally {
    releaseLock?.();
  }
}
