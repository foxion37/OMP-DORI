import { readFileSync, realpathSync } from "node:fs";
import { readPaneState } from "../../skills/dori-mode/scripts/src/lane-state.ts";
import type { HerdrCli } from "../runtime/herdr/exec.ts";
import { foreground } from "../runtime/herdr/probe.ts";
import { start } from "../runtime/herdr/sessions.ts";
import { completedLegacyRollbackForeground, legacyRollbackForeground } from "./deployment-legacy-monitors.ts";
import { captureRuntime, requireShell } from "./deployment-native.ts";
import { runtimeUsesToolchain } from "./deployment-prior.ts";
import { actorEnv, DeploymentHeld, processIdentity, sameProcess, underProcess } from "./deployment-process.ts";
import { bareRootShell } from "./deployment-shell.ts";
import { terminateBoundProcess } from "./deployment-signal.ts";
import { assertRuntimeToolchain } from "./deployment-toolchain.ts";
import type { DeploymentConfig, DeploymentRecord, ProcessIdentity } from "./deployment-types.ts";

/** A matching live launch remains present while its foreground receipts converge. */
export class LaunchedProcessHeld extends DeploymentHeld {
  constructor(
    readonly identity: ProcessIdentity,
    message: string,
  ) {
    super(message);
  }
}

/** Same session file, same pane and role. Explicit environment replaces ambient tokens/sudo and leaves policy in place. */
export async function launchRuntime(
  config: DeploymentConfig,
  cli: HerdrCli,
  record: DeploymentRecord,
  bootstrap = false,
  prior = false,
): Promise<void> {
  const previous = record.oldRuntime;
  const toolchain = prior ? record.oldToolchain : record.toolchain;
  if (!previous || !toolchain) throw new DeploymentHeld("native launch lacks its identity/toolchain journal");
  assertRuntimeToolchain(config, toolchain);
  await requireShell(config, cli);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const env = { ...actorEnv(config, toolchain), DORI_MANAGED_STARTUP: "1" };
  const argv = [
    "/usr/bin/env",
    "-i",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    toolchain.omp,
    "--config",
    toolchain.nativeConfig,
    `--resume=${previous.sessionFile}`,
    "--dori-role",
    "dori",
    "--model",
    config.model,
    ...(bootstrap && config.monitorBootstrapFile ? [`--dori-monitor-bootstrap=${config.monitorBootstrapFile}`] : []),
  ];
  await start(cli, config.pane, `cd ${quote(previous.cwd)} && ${argv.map(quote).join(" ")}`);
}

/** Binds a failed startup even when extension initialization never wrote its role receipt. */
export async function launchedProcess(
  config: DeploymentConfig,
  cli: HerdrCli,
  record: DeploymentRecord,
  since: string,
  prior = false,
): Promise<ProcessIdentity | undefined> {
  const previous = record.oldRuntime;
  const toolchain = prior ? record.oldToolchain : record.toolchain;
  if (!previous || !toolchain) throw new DeploymentHeld("native startup lacks its identity/toolchain journal");
  const front = await foreground(cli, config.pane, "deployment held");
  const legacyRollback = prior && record.bootstrap === true && record.rollbackLaunchRequestedAt === since;
  const matches = (front.processes ?? []).flatMap((entry) => {
    if (!entry.pid || !front.rootPid || !underProcess(entry.pid, front.rootPid)) return [];
    const identity = processIdentity(entry.pid);
    if (
      !identity ||
      (identity.executable !== toolchain.ompEntry && identity.executable !== realpathSync(toolchain.bun))
    )
      return [];
    const argv = readFileSync(`/proc/${entry.pid}/cmdline`, "utf8").split("\0");
    if (
      !argv.includes(`--resume=${previous.sessionFile}`) ||
      !argv.includes("--dori-role") ||
      !argv.includes("dori") ||
      !argv.includes("--model") ||
      !argv.includes(config.model) ||
      !argv.includes("--config") ||
      !argv.includes(toolchain.nativeConfig) ||
      (identity.executable !== toolchain.ompEntry &&
        !argv.includes(toolchain.omp) &&
        !argv.includes(toolchain.ompEntry))
    )
      return [];
    return [identity];
  });
  if (matches.length === 0 && bareRootShell(config, front)) return undefined;
  if (matches.length !== 1) throw new DeploymentHeld("startup process identity is ambiguous");
  const identity = matches[0]!;
  const startTime = await cli.exec("ps", ["-o", "lstart=", "-p", String(identity.pid)]);
  const at = Date.parse(startTime.stdout.trim());
  const requestedAt = Date.parse(since);
  // ps boot/jiffy conversion plus whole-second lstart output has a two-second precision window.
  if (!Number.isFinite(at) || !Number.isFinite(requestedAt) || at < requestedAt - 2_000 || !sameProcess(identity))
    throw new DeploymentHeld("startup process predates the journaled launch");
  const expected = prior ? record.rollbackProcess : record.launchProcess;
  if (expected && !sameProcess(expected, identity))
    throw new DeploymentHeld("startup process differs from its journaled incarnation");
  if (front.shell) {
    try {
      assertRuntimeToolchain(config, toolchain);
      const attestRollback =
        record.status === "rolled-back" || record.step === "done"
          ? completedLegacyRollbackForeground
          : legacyRollbackForeground;
      const runtime = await captureRuntime(
        config,
        cli,
        true,
        undefined,
        legacyRollback ? attestRollback(config, record, since, identity) : undefined,
      );
      if (
        !sameProcess(identity, runtime) ||
        runtime.sessionFile !== previous.sessionFile ||
        runtime.cwd !== previous.cwd ||
        !Number.isFinite(Date.parse(runtime.startedAt)) ||
        Date.parse(runtime.startedAt) < requestedAt ||
        !runtimeUsesToolchain(runtime, toolchain)
      )
        throw new DeploymentHeld("startup foreground differs from its journaled native launch");
    } catch (error) {
      if (error instanceof DeploymentHeld) throw new LaunchedProcessHeld(identity, error.message);
      throw error;
    }
  }
  return identity;
}

export async function stopLaunchedProcess(
  config: DeploymentConfig,
  cli: HerdrCli,
  record: DeploymentRecord,
  since: string,
  expected: ProcessIdentity,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + config.stopTimeoutMs;
  let held: DeploymentHeld | undefined;
  for (;;) {
    if (signal?.aborted) throw new DeploymentHeld("startup stop observation interrupted");
    if (Date.now() >= deadline) throw held ?? new DeploymentHeld("startup stop observation exceeded its bound");
    try {
      if (!sameProcess(expected)) {
        if (processIdentity(expected.pid)) throw new DeploymentHeld("startup PID has been reused");
        await requireShell(config, cli, expected, deadline);
        return;
      }
      const actual = await launchedProcess(config, cli, record, since);
      if (!actual || !sameProcess(expected, actual))
        throw new DeploymentHeld("startup process changed before rollback");
      const state = readPaneState(config.stateDir, config.pane);
      if (
        state?.pid === expected.pid &&
        state.sessionId === config.sessionId &&
        (state.approvalPending || state.agentStatus === "working")
      )
        throw new DeploymentHeld("resumed Dori has owner work or an approval; rollback is held until idle");
      if (state?.pid === expected.pid && state.sessionId === config.sessionId) {
        const runtime = await captureRuntime(config, cli);
        if (!sameProcess(expected, runtime)) throw new DeploymentHeld("startup owner changed before rollback");
      }
    } catch (error) {
      if (!(error instanceof DeploymentHeld) || signal?.aborted || Date.now() >= deadline) throw error;
      held = error;
      await Bun.sleep(Math.min(50, Math.max(0, deadline - Date.now())));
      continue;
    }
    break;
  }
  if (signal?.aborted) throw new DeploymentHeld("startup stop observation interrupted");
  if (Date.now() >= deadline) throw held ?? new DeploymentHeld("startup stop observation exceeded its bound");
  terminateBoundProcess(expected);
  const until = Date.now() + config.stopTimeoutMs;
  while (sameProcess(expected) && Date.now() < until) await Bun.sleep(50);
  if (sameProcess(expected)) throw new DeploymentHeld("failed startup did not stop");
  await requireShell(config, cli, expected, until);
}
