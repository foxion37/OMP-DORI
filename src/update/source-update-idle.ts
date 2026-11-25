import { join } from "node:path";
import { Registry, statusOf } from "../../skills/cataly-mode/scripts/src/registry.ts";
import { captureRuntime, observeLead } from "./deployment-harness.ts";
import { readMonitorSet } from "./deployment-monitors.ts";
import { DeploymentHeld, sameProcess, underProcess } from "./deployment-process.ts";
import type { MonitorSet, RuntimeIdentity } from "./deployment-types.ts";
import { readInboundActivity } from "./source-activity.ts";
import type { SourceUpdateConfig } from "./source-update-config.ts";

/** Read-only eligibility. Private session files are never opened; the lead's headless broker proves idle and approval. */
export async function sourceIdle(
  config: SourceUpdateConfig,
  signal?: AbortSignal,
  expected?: RuntimeIdentity,
): Promise<{ runtime: RuntimeIdentity; quietMs: number; receivers: number }> {
  if (signal?.aborted) throw new DeploymentHeld("idle observation interrupted");
  const runtime = await captureRuntime(config.deployment);
  if (
    expected &&
    (!sameProcess(expected, runtime) ||
      expected.ref !== runtime.ref ||
      expected.sessionFile !== runtime.sessionFile ||
      expected.startedAt !== runtime.startedAt)
  )
    throw new DeploymentHeld("lead identity changed before the source operation");
  return sourceIdleNow(config, runtime);
}

/** Repeat after all asynchronous observations, immediately before the native stop receipt and effect. */
export async function sourceIdleNow(config: SourceUpdateConfig, runtime: RuntimeIdentity) {
  const deployment = config.deployment;
  const scan = new Registry(deployment.stateDir).scanNow(true);
  if (scan.unreadable.length) throw new DeploymentHeld("unreadable lane records prevent an idle decision");
  const open = scan.lanes.filter((lane) => statusOf(lane) !== "closed");
  if (open.length)
    throw new DeploymentHeld(`open lanes: ${open.map((lane) => `${lane.key}(${statusOf(lane)})`).join(", ")}`);
  const latest = await observeLead(deployment);
  if (
    latest.role !== "cataly" ||
    latest.pid !== runtime.pid ||
    latest.sessionId !== runtime.sessionId ||
    latest.startedAt !== runtime.startedAt ||
    latest.sessionFile !== runtime.sessionFile ||
    latest.cwd !== runtime.cwd ||
    latest.held ||
    latest.status !== "idle"
  )
    throw new DeploymentHeld("lead is no longer idle or its identity changed");
  if (underProcess(process.pid, runtime.pid))
    throw new DeploymentHeld("source controller must run outside the lead process tree");
  const desired = join(deployment.stateDir, "monitors", encodeURIComponent(runtime.sessionId) + ".json");
  let monitors: MonitorSet;
  try {
    monitors = readMonitorSet(desired, runtime.sessionId);
  } catch (error) {
    throw new DeploymentHeld("managed intake evidence unavailable", { cause: error });
  }
  if (!config.activityFiles.some((path) => path + ".heartbeat" === monitors.intake.path))
    throw new DeploymentHeld("managed intake heartbeat must belong to a configured activity receiver");
  const now = Date.now();
  let quietMs = Number.MAX_SAFE_INTEGER;
  for (const path of config.activityFiles) {
    let activity: ReturnType<typeof readInboundActivity>;
    try {
      activity = readInboundActivity(path);
    } catch (error) {
      throw new DeploymentHeld(`inbound activity evidence unavailable: ${path}`, { cause: error });
    }
    if (
      !activity.available ||
      activity.healthyAt <= 0 ||
      activity.quietSince <= 0 ||
      activity.updatedAt > now ||
      activity.healthyAt > activity.updatedAt ||
      activity.quietSince > activity.updatedAt ||
      now - activity.healthyAt > config.activityMaxAgeMs ||
      activity.process.pid === runtime.pid ||
      !underProcess(activity.process.pid, runtime.pid)
    )
      throw new DeploymentHeld("inbound activity is unavailable, stale, future-dated or not owned by this lead");
    quietMs = Math.min(quietMs, now - activity.quietSince);
  }
  if (quietMs < config.ownerQuietMs)
    throw new DeploymentHeld("owner quiet period has not reached the configured minimum");
  if (!sameProcess(runtime)) throw new DeploymentHeld("lead process changed during idle observation");
  return { runtime, quietMs, receivers: config.activityFiles.length };
}
