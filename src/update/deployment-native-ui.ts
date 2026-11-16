import { readFileSync, realpathSync } from "node:fs";
import { readPaneState } from "../../skills/dori-mode/scripts/src/lane-state.ts";
import type { DeploymentCli } from "./deployment-cli.ts";
import { attestMonitorForeground } from "./deployment-monitor-receipts.ts";
import { DeploymentBusy, DeploymentHeld, sameProcess, underProcess } from "./deployment-process.ts";
import type { DeploymentConfig, DeploymentRecord, RuntimeIdentity } from "./deployment-types.ts";
import { sourceManifest } from "./source.ts";

/** Only the observed two-row empty native editors; unknown layouts and drafts stay held. */
function emptyNativeInput(screen: string): boolean {
  const lines = screen.split("\n");
  while (lines.at(-1) === "") lines.pop();
  const [header, input] = lines.slice(-2);
  return (
    (typeof header === "string" &&
      /^╭─+ .+─+╮$/.test(header) &&
      /^╰─ +(?:⇧⇥ to change thinking effort )?─╯$/.test(input ?? "")) ||
    (typeof header === "string" && /^ π > ⬢ .+ > .+$/.test(header) && input === "╰─")
  );
}

/** A failed acknowledgement cannot disprove delivery; the caller must still observe exit and the bare shell. */
export async function requestNativeUiExit(cli: DeploymentCli, pane: string): Promise<DeploymentHeld | undefined> {
  if (!cli.nativeUi) throw new DeploymentHeld("native UI stop requires Linux herdr screen and exit support");
  try {
    await cli.nativeUi.exit(pane);
    return undefined;
  } catch {
    return new DeploymentHeld("native UI exit acknowledgement is unavailable and exit remains unobserved");
  }
}

/** Never certify a possibly exiting old actor as restored; keep both consumers' forward intent resumable. */
export function holdPendingNativeUiExit(record: DeploymentRecord): boolean {
  if (!record.nativeUiExitRequestedAt || record.step !== "stop") return false;
  record.status = "held";
  return true;
}

/** Reobserve immediately before the durable one-shot request; this never interrupts a working actor. */
export async function assertNativeUiIdle(
  config: DeploymentConfig,
  cli: DeploymentCli,
  record: DeploymentRecord,
  expected: RuntimeIdentity,
): Promise<void> {
  if (!cli.nativeUi) throw new DeploymentHeld("native UI stop requires Linux herdr screen and exit support");
  const current = await cli.probe(config.pane, "deployment held", config.stateDir);
  const screen = await cli.nativeUi.read(config.pane, 30);
  const group = (pid: number): number => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  };
  if (
    current.pgid !== group(expected.pid) ||
    !current.foreground ||
    current.foreground.filter(({ pid }) => pid === expected.pid).length !== 1 ||
    new Set(current.foreground.map(({ pid }) => pid)).size !== current.foreground.length ||
    current.foreground.some(({ pid }) => !pid || !underProcess(pid, expected.pid) || group(pid) !== current.pgid)
  )
    throw new DeploymentHeld("native UI foreground ownership changed before stop");
  if (current.shellInFront) attestMonitorForeground(config, expected, current);
  for (const monitor of record.oldMonitors ?? []) {
    if (!sameProcess(monitor) || monitor.pid === expected.pid || !underProcess(monitor.pid, expected.pid))
      throw new DeploymentHeld("monitor identity changed before native stop");
  }
  if (record.oldSourceHash && sourceManifest(realpathSync(config.liveSource)).hash !== record.oldSourceHash)
    throw new DeploymentHeld("previous source changed after its handoff journal");
  if (underProcess(process.pid, expected.pid) || group(process.pid) === current.pgid)
    throw new DeploymentHeld("UI replacement controller must run independently outside the target actor");
  const state = readPaneState(config.stateDir, config.pane);
  if (current.status === "working" || state?.agentStatus === "working")
    throw new DeploymentBusy("native Dori is busy; waiting for its idle boundary");
  if (
    (current.status !== "idle" && current.status !== "done") ||
    current.agent !== "omp" ||
    current.pid !== expected.pid ||
    current.sessionId !== expected.sessionId ||
    expected.pane !== config.pane ||
    expected.sessionId !== config.sessionId ||
    !state ||
    state.role !== "dori" ||
    state.paneId !== config.pane ||
    state.pid !== expected.pid ||
    state.sessionId !== expected.sessionId ||
    state.sessionFile !== expected.sessionFile ||
    state.startedAt !== expected.startedAt ||
    state.cwd !== expected.cwd ||
    state.approvalPending ||
    state.agentStatus !== "idle" ||
    !current.rootPid ||
    !underProcess(expected.pid, current.rootPid) ||
    !emptyNativeInput(screen)
  )
    throw new DeploymentHeld("native UI stop requires the same idle owner and observed empty native input");
  if (!sameProcess(expected)) throw new DeploymentHeld("native runtime changed before UI stop");
}
