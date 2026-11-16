import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { interactiveShellInFront } from "../runtime/foreground.ts";
import type { Probe } from "../runtime/types.ts";
import type { LegacyRollbackForeground } from "./deployment-legacy-monitors.ts";
import { readMonitorSet, sameMonitorSpecs } from "./deployment-monitors.ts";
import { DeploymentHeld, processIdentity, sameProcess, underProcess } from "./deployment-process.ts";
import type {
  DeploymentConfig,
  MonitorProcessIdentity,
  MonitorSet,
  RuntimeHealth,
  RuntimeIdentity,
} from "./deployment-types.ts";
import { procCmdline, procCwd, procStat } from "./proc.ts";

export function readRuntimeHealth(config: DeploymentConfig): RuntimeHealth | undefined {
  const path = join(config.stateDir, "runtime", `${encodeURIComponent(config.pane)}.json`);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || (stat.mode & 0o022) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid()))
    throw new DeploymentHeld("runtime health ownership differs");
  const value = JSON.parse(readFileSync(path, "utf8")) as RuntimeHealth;
  if (
    value.version !== 1 ||
    !Array.isArray(value.monitors) ||
    value.paneId !== config.pane ||
    value.sessionId !== config.sessionId ||
    value.role !== "dori" ||
    typeof value.presetLoaded !== "boolean" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    Date.parse(value.updatedAt) < Date.parse(value.startedAt) ||
    Date.parse(value.updatedAt) > Date.now() + 1_000
  )
    throw new DeploymentHeld("runtime health schema differs");
  return value;
}

export function monitorProcessReceipts(
  config: DeploymentConfig,
  runtime: RuntimeIdentity,
  wanted: MonitorSet,
  bootstrap: boolean,
): readonly MonitorProcessIdentity[] {
  if (wanted.sessionId !== runtime.sessionId || !sameProcess(runtime))
    throw new DeploymentHeld("monitor receipts differ from native runtime");
  let running = wanted.running;
  let health: RuntimeHealth | undefined;
  if (!bootstrap) {
    health = readRuntimeHealth(config);
    if (
      !health ||
      health.pid !== runtime.pid ||
      health.sessionId !== runtime.sessionId ||
      health.startedAt !== runtime.startedAt ||
      Date.now() - Date.parse(health.updatedAt) > 5_000 ||
      !sameMonitorSpecs(health.monitors, wanted.monitors)
    )
      throw new DeploymentHeld("monitor writer differs from native runtime");
    running = health.monitors.map(({ name, pid }) => ({ name, pid }));
  }
  if (
    !running ||
    running.length !== wanted.monitors.length ||
    new Set(running.map(({ pid }) => pid)).size !== running.length ||
    wanted.monitors.some((spec) => !running?.some((p) => p.name === spec.name))
  )
    throw new DeploymentHeld("first handoff needs complete trusted native monitor PID receipts");
  const receipts = running.map(({ name, pid, identity: saved }) => {
    const identity = processIdentity(pid);
    const observed = health?.monitors.find((entry) => entry.name === name);
    if (
      !identity ||
      pid === runtime.pid ||
      identity.bootId !== runtime.bootId ||
      !underProcess(pid, runtime.pid) ||
      (saved !== undefined && !sameProcess(saved, identity)) ||
      (health !== undefined && observed?.startTicks !== identity.startTicks)
    )
      throw new DeploymentHeld("monitor is no longer owned by target runtime");
    const argv = procCmdline(pid).split("\0").filter(Boolean);
    if (!sameProcess(identity)) throw new DeploymentHeld("monitor PID changed during capture");
    return { ...identity, name, argv };
  });
  if (!sameProcess(runtime)) throw new DeploymentHeld("native PID changed during monitor capture");
  return receipts;
}

/** Deployment alone may discount exact monitor incarnations; delivery keeps the generic shell guard. */
export function attestMonitorForeground(
  config: DeploymentConfig,
  runtime: RuntimeIdentity,
  current: Probe,
  rollback?: LegacyRollbackForeground,
): void {
  const processes = current.foreground;
  const group = (pid: number): number => {
    return procStat(pid).pgid;
  };
  if (
    current.pgid !== runtime.pid ||
    !current.rootPid ||
    current.rootPid === runtime.pid ||
    !underProcess(runtime.pid, current.rootPid) ||
    !processes?.length ||
    processes.filter(({ pid }) => pid === runtime.pid).length !== 1 ||
    new Set(processes.map(({ pid }) => pid)).size !== processes.length ||
    group(runtime.pid) !== current.pgid
  )
    throw new DeploymentHeld("native foreground group ownership is unavailable");
  const foreground = processes.map(({ pid }) => {
    const identity = pid === undefined ? undefined : processIdentity(pid);
    if (
      !identity ||
      pid === current.rootPid ||
      identity.bootId !== runtime.bootId ||
      group(identity.pid) !== current.pgid
    )
      throw new DeploymentHeld("foreground process ownership differs");
    return identity;
  });
  const health = readRuntimeHealth(config);
  let wanted: MonitorSet;
  let monitors: readonly MonitorProcessIdentity[];
  if (rollback && health === undefined) {
    wanted = rollback.monitors;
    monitors = rollback.running;
  } else {
    const bootstrap = health === undefined;
    if (bootstrap && !config.monitorBootstrapFile)
      throw new DeploymentHeld("foreground monitors need trusted bootstrap receipts");
    wanted = readMonitorSet(
      bootstrap
        ? config.monitorBootstrapFile!
        : join(config.stateDir, "monitors", `${encodeURIComponent(config.sessionId)}.json`),
      runtime.sessionId,
      bootstrap,
    );
    if (bootstrap) {
      const owner = wanted.runtime;
      if (
        !owner ||
        owner.pane !== runtime.pane ||
        owner.role !== runtime.role ||
        owner.sessionId !== runtime.sessionId ||
        owner.startedAt !== runtime.startedAt ||
        !sameProcess(owner, runtime) ||
        !wanted.running?.every(({ identity }) => identity !== undefined)
      )
        throw new DeploymentHeld("foreground bootstrap lacks native and monitor incarnation receipts");
    }
    monitors = monitorProcessReceipts(config, runtime, wanted, bootstrap);
  }
  const exempt = monitors.filter((monitor) =>
    processes.some((entry) => entry.pid === monitor.pid && interactiveShellInFront([entry])),
  );
  for (const monitor of exempt) {
    const spec = wanted.monitors.find((entry) => entry.name === monitor.name)!;
    const interpreter = basename(monitor.argv[0] ?? "");
    const script = monitor.argv[1];
    if (
      !["bash", "sh", "dash"].includes(interpreter) ||
      basename(monitor.executable) !== interpreter ||
      !script ||
      script.startsWith("-") ||
      !lstatSync(resolve(spec.cwd, script)).isFile()
    )
      throw new DeploymentHeld("foreground monitor is not an attested shell script");
    const command = monitor.argv.length === spec.argv.length + 1 ? monitor.argv.slice(1) : monitor.argv;
    if (
      command.length !== spec.argv.length ||
      command.some((arg, index) => {
        const expected = spec.argv[index] ?? "";
        return index === 0
          ? isAbsolute(arg) && isAbsolute(expected)
            ? realpathSync(arg) !== realpathSync(expected)
            : basename(arg) !== basename(expected)
          : arg !== expected;
      }) ||
      realpathSync(procCwd(monitor.pid)) !== realpathSync(spec.cwd)
    )
      throw new DeploymentHeld("foreground monitor command or cwd differs");
  }
  const remaining = processes.filter(({ pid }) => !exempt.some((monitor) => monitor.pid === pid));
  if (
    interactiveShellInFront(remaining) ||
    !sameProcess(runtime) ||
    foreground.some((identity) => !sameProcess(identity) || group(identity.pid) !== current.pgid) ||
    monitors.some((monitor) => !sameProcess(monitor) || !underProcess(monitor.pid, runtime.pid))
  )
    throw new DeploymentHeld("native foreground still contains a shell or changed process");
}
