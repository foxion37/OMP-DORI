import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readActiveDeployment } from "./deployment-active.ts";
import { captureHandoff, prepareLauncher } from "./deployment-handoff.ts";
import { captureRuntime, nativeCli } from "./deployment-native.ts";
import { DeploymentHeld, sameProcess, underProcess } from "./deployment-process.ts";
import type { DeploymentConfig, DeploymentRecord } from "./deployment-types.ts";
import { sourceManifest } from "./source.ts";

export function assertPreparedLayout(config: DeploymentConfig, record: DeploymentRecord): void {
  if (
    !record.preparedAt ||
    !record.oldSourceHash ||
    !record.pointers ||
    record.stopRequestedAt ||
    (record.step !== "prepare" && record.step !== "stop")
  )
    throw new DeploymentHeld("busy hold is no longer before native effects");
  if (sourceManifest(realpathSync(config.liveSource)).hash !== record.oldSourceHash)
    throw new DeploymentHeld("busy hold source changed");
  const paths = [config.liveSource, ...config.shims.map((shim) => shim.path), config.launcherPath];
  const targets = [
    record.releasePath,
    ...config.shims.map((shim) => join(config.liveSource, shim.source)),
    join(record.directory, "managed-restart.sh"),
  ];
  if (record.pointers.length !== paths.length) throw new DeploymentHeld("busy hold pointer inventory differs");
  for (const [index, pointer] of record.pointers.entries()) {
    const current = lstatSync(pointer.path, { throwIfNoEntry: false });
    if (
      pointer.path !== paths[index] ||
      pointer.target !== targets[index] ||
      lstatSync(pointer.backup, { throwIfNoEntry: false }) ||
      lstatSync(pointer.displaced, { throwIfNoEntry: false }) ||
      (pointer.original
        ? !current || current.dev !== pointer.original.dev || current.ino !== pointer.original.ino
        : current !== undefined)
    )
      throw new DeploymentHeld("busy hold installation pointers changed");
  }
}

/** A busy retry requires the same intact native handoff; approvals, changed ownership and partial effects stay held. */
export async function verifyBusyHold(config: DeploymentConfig, record: DeploymentRecord): Promise<void> {
  assertPreparedLayout(config, record);
  if (!record.oldRuntime || !record.oldMonitors || record.quiesceHash)
    throw new DeploymentHeld("busy hold lacks an intact native handoff");
  const current = await captureRuntime(config, nativeCli(config), true);
  if (
    current.approvalPending ||
    !sameProcess(record.oldRuntime, current) ||
    current.startedAt !== record.oldRuntime.startedAt ||
    current.sessionFile !== record.oldRuntime.sessionFile ||
    current.executableHash !== record.oldRuntime.executableHash
  )
    throw new DeploymentHeld("busy hold native identity or approval boundary changed");
  for (const monitor of record.oldMonitors) {
    if (!sameProcess(monitor) || !underProcess(monitor.pid, current.pid))
      throw new DeploymentHeld("busy hold monitor identities changed");
  }
}

/** A completed managed model-watch restart may replace the PID while retaining this exact source/session/layout. */
export async function refreshBusyHandoff(config: DeploymentConfig, record: DeploymentRecord): Promise<void> {
  assertPreparedLayout(config, record);
  const previous = record.oldRuntime;
  if (!previous || record.quiesceHash) throw new DeploymentHeld("busy retry has no unconsumed native handoff");
  const current = await captureRuntime(config, nativeCli(config), true);
  if (current.approvalPending || current.sessionFile !== previous.sessionFile)
    throw new DeploymentHeld("busy retry native approval or session changed");
  if (!sameProcess(previous, current)) {
    const active = readActiveDeployment(config);
    if (
      !active ||
      active.sourceHash !== record.oldSourceHash ||
      !sameProcess(active.runtime, current) ||
      active.runtime.sessionId !== current.sessionId ||
      active.runtime.startedAt !== current.startedAt
    )
      throw new DeploymentHeld("busy retry has no verified managed restart receipt");
    delete record.oldToolchain;
  }
  const sourceHash = record.oldSourceHash;
  const sessionFile = previous.sessionFile;
  delete record.oldRuntime;
  const recaptured = await captureHandoff(config, record, prepareLauncher(config, record));
  if (record.oldSourceHash !== sourceHash || recaptured.sessionFile !== sessionFile)
    throw new DeploymentHeld("busy retry source or session changed during capture");
}
