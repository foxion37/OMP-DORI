import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { readPaneState } from "../../skills/dori-mode/scripts/src/lane-state.ts";
import { DeploymentHeld, processIdentity, sameProcess } from "./deployment-process.ts";
import type {
  DeploymentConfig,
  DeploymentRecord,
  MonitorProcessIdentity,
  MonitorSet,
  ProcessIdentity,
  RuntimeIdentity,
} from "./deployment-types.ts";
import { sourceManifest } from "./source.ts";
import { procChildren, procCmdline, procCwd } from "./proc.ts";

/** Only monitor argv metadata is inspected; session/model files are neither opened nor copied. */
export function legacyMonitorReceipts(
  root: number,
  previous: readonly MonitorProcessIdentity[],
): readonly MonitorProcessIdentity[] {
  const descendants: number[] = [];
  const visit = (pid: number): void => {
    let children: number[];
    try {
      children = procChildren(pid);
    } catch {
      return;
    }
    for (const child of children) {
      if (descendants.includes(child)) continue;
      descendants.push(child);
      visit(child);
    }
  };
  visit(root);
  const used = new Set<number>();
  return previous.map((old) => {
    const matches = descendants.flatMap((pid): MonitorProcessIdentity[] => {
      if (used.has(pid)) return [];
      const identity = processIdentity(pid);
      if (!identity || basename(identity.executable) !== basename(old.executable)) return [];
      try {
        const argv = procCmdline(pid).split("\0").filter(Boolean);
        if (
          argv.length !== old.argv.length ||
          argv.some((arg, index) =>
            index === 0 ? basename(arg) !== basename(old.argv[0] ?? "") : arg !== old.argv[index],
          )
        )
          return [];
        return [{ ...identity, name: old.name, argv }];
      } catch {
        return [];
      }
    });
    if (matches.length !== 1) throw new DeploymentHeld("legacy monitor identity is missing or ambiguous");
    const found = matches[0]!;
    used.add(found.pid);
    return found;
  });
}

const rollbackReceipt = Symbol("controller-owned legacy rollback foreground");
export type LegacyRollbackForeground = {
  readonly [rollbackReceipt]: true;
  readonly runtime: RuntimeIdentity;
  readonly monitors: MonitorSet;
  readonly running: readonly MonitorProcessIdentity[];
};

function captureLegacyRollbackForeground(
  config: DeploymentConfig,
  record: DeploymentRecord,
  since: string,
  expected: ProcessIdentity,
): LegacyRollbackForeground {
  if (
    record.bootstrap !== true ||
    !record.stopRequestedAt ||
    !record.rollbackRequestedAt ||
    record.rollbackLaunchRequestedAt !== since ||
    !Number.isFinite(Date.parse(since)) ||
    !Number.isFinite(Date.parse(record.rollbackRequestedAt)) ||
    Date.parse(since) < Date.parse(record.rollbackRequestedAt) ||
    !record.oldRuntime ||
    !record.oldMonitors ||
    !record.monitors ||
    processIdentity(record.oldRuntime.pid) !== undefined ||
    expected.imageDev === undefined ||
    expected.imageIno === undefined ||
    !sameProcess(expected) ||
    (record.rollbackProcess !== undefined && !sameProcess(record.rollbackProcess, expected))
  )
    throw new DeploymentHeld("legacy foreground lacks its controller-owned rollback launch");
  const state = readPaneState(config.stateDir, config.pane);
  if (
    !state ||
    state.pid !== expected.pid ||
    state.paneId !== config.pane ||
    state.role !== "dori" ||
    state.sessionId !== config.sessionId ||
    state.paneId !== record.oldRuntime.pane ||
    state.role !== record.oldRuntime.role ||
    state.sessionId !== record.oldRuntime.sessionId ||
    typeof state.sessionFile !== "string" ||
    !state.sessionFile ||
    state.sessionFile !== record.oldRuntime.sessionFile ||
    state.cwd !== record.oldRuntime.cwd ||
    realpathSync(procCwd(expected.pid)) !== realpathSync(record.oldRuntime.cwd) ||
    !Number.isFinite(Date.parse(state.startedAt)) ||
    Date.parse(state.startedAt) < Date.parse(since)
  )
    throw new DeploymentHeld("legacy rollback pane, session, role or start receipt differs");
  const running = legacyMonitorReceipts(expected.pid, record.oldMonitors);
  if (
    record.monitors.sessionId !== record.oldRuntime.sessionId ||
    running.length !== record.monitors.monitors.length ||
    new Set(running.map(({ name }) => name)).size !== running.length ||
    running.some((monitor) => {
      const spec = record.monitors!.monitors.find(({ name }) => name === monitor.name);
      const old = record.oldMonitors!.find(({ name }) => name === monitor.name)!;
      return (
        !spec ||
        monitor.argv.some((arg, index) => arg !== old.argv[index]) ||
        realpathSync(procCwd(monitor.pid)) !== realpathSync(spec.cwd) ||
        !sameProcess(monitor)
      );
    }) ||
    !sameProcess(expected)
  )
    throw new DeploymentHeld("legacy rollback monitor command, cwd or incarnation differs");
  return {
    [rollbackReceipt]: true,
    runtime: {
      ...expected,
      pane: state.paneId,
      role: state.role,
      sessionId: state.sessionId,
      sessionFile: state.sessionFile,
      startedAt: state.startedAt,
      cwd: state.cwd,
    },
    monitors: record.monitors,
    running,
  };
}

/** Only an in-progress controller rollback may establish its initial launch receipt. */
export function legacyRollbackForeground(
  config: DeploymentConfig,
  record: DeploymentRecord,
  since: string,
  expected: ProcessIdentity,
): LegacyRollbackForeground {
  if (record.step !== "rollback" || record.status === "rolled-back")
    throw new DeploymentHeld("legacy rollback launch is not in progress");
  return captureLegacyRollbackForeground(config, record, since, expected);
}

/** Read-only re-attestation of the exact already-completed rollback, never a launch authorization. */
export function completedLegacyRollbackForeground(
  config: DeploymentConfig,
  record: DeploymentRecord,
  since: string,
  expected: ProcessIdentity,
): LegacyRollbackForeground {
  const completed = record.rollbackRuntime;
  const healthyAt = Date.parse(record.rollbackHealthyAt ?? "");
  if (
    record.status !== "rolled-back" ||
    record.step !== "done" ||
    !Number.isFinite(healthyAt) ||
    healthyAt < Date.parse(since) ||
    !record.rollbackProcess ||
    !sameProcess(record.rollbackProcess, expected) ||
    !completed ||
    !sameProcess(completed, expected) ||
    healthyAt < Date.parse(completed.startedAt) ||
    !record.oldSource ||
    !record.oldSourceHash ||
    realpathSync(config.liveSource) !== realpathSync(record.oldSource) ||
    sourceManifest(realpathSync(record.oldSource)).hash !== record.oldSourceHash
  )
    throw new DeploymentHeld("completed legacy rollback receipt or source differs");
  const receipt = captureLegacyRollbackForeground(config, record, since, expected);
  if (
    receipt.runtime.pane !== completed.pane ||
    receipt.runtime.role !== completed.role ||
    receipt.runtime.sessionId !== completed.sessionId ||
    receipt.runtime.sessionFile !== completed.sessionFile ||
    receipt.runtime.startedAt !== completed.startedAt ||
    receipt.runtime.cwd !== completed.cwd
  )
    throw new DeploymentHeld("completed legacy rollback runtime differs from its healthy receipt");
  return receipt;
}
