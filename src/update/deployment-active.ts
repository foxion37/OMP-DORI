import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesDeploymentConfigHash } from "./deployment-config.ts";
import { saveDeploymentJson } from "./deployment-files.ts";
import { captureRuntime } from "./deployment-harness.ts";
import { leadRuntimeHealth, monitorProcessReceipts } from "./deployment-monitor-receipts.ts";
import { currentReceipt } from "./deployment-previous-main.ts";
import { runtimeUsesToolchain } from "./deployment-prior.ts";
import { actorEnv, command, DeploymentHeld, sameProcess } from "./deployment-process.ts";
import { assertRuntimeToolchain } from "./deployment-toolchain.ts";
import { digest, sourceManifest } from "./source.ts";
import type {
  DeploymentConfig,
  DeploymentRecord,
  MonitorProcessIdentity,
  RuntimeIdentity,
  ToolchainReceipt,
} from "./deployment-types.ts";

export type ActiveDeployment = {
  readonly version: 1;
  readonly configHash: string;
  readonly source: string;
  readonly sourceHash: string;
  readonly runtime: RuntimeIdentity;
  readonly monitorProcesses: readonly MonitorProcessIdentity[];
  readonly toolchain: ToolchainReceipt;
};

export function readActiveDeployment(config: DeploymentConfig): ActiveDeployment | undefined {
  let active: ActiveDeployment;
  try {
    active = JSON.parse(readFileSync(join(config.releaseRoot, "active.json"), "utf8")) as ActiveDeployment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // A malformed receipt stays as written, for the ordinary checks that hold on it.
  return typeof active === "object" && active !== null
    ? { ...active, toolchain: currentReceipt(active.toolchain) }
    : active;
}

/** Observe the current deployment without activating it; native verification retains its cache leases. */
export async function inspectActiveDeployment(config: DeploymentConfig, signal?: AbortSignal) {
  try {
    const active = readActiveDeployment(config);
    if (!active || active.version !== 1 || !matchesDeploymentConfigHash(config, active.configHash))
      throw new DeploymentHeld("no matching managed active receipt");
    const runtime = await captureRuntime(config, true);
    if (
      !sameProcess(active.runtime, runtime) ||
      active.runtime.ref !== runtime.ref ||
      active.runtime.startedAt !== runtime.startedAt ||
      active.runtime.sessionId !== runtime.sessionId ||
      active.runtime.sessionFile !== runtime.sessionFile
    )
      throw new DeploymentHeld("active receipt does not own the current native session/PID");
    const temporary = mkdtempSync(join(tmpdir(), "cataly-status-"));
    try {
      const held = JSON.parse(
        await command(
          [process.execPath, import.meta.path],
          config.home,
          { ...actorEnv(config), TMPDIR: temporary },
          15_000,
          signal,
          JSON.stringify({ config, active, runtime }),
        ),
      ) as string | null;
      if (held !== null) throw new DeploymentHeld(held);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    const source = active.source;
    if (signal?.aborted || !sameProcess(runtime) || realpathSync(config.liveSource) !== source)
      throw new DeploymentHeld("runtime changed during revision observation");
    return {
      status: "running" as const,
      checkedAt: new Date().toISOString(),
      source,
      sourceHash: active.sourceHash,
      pid: runtime.pid,
      sessionId: runtime.sessionId,
      startedAt: runtime.startedAt,
      nativeVersion: active.toolchain.nativeVersion,
      nativeBundleIdentity: active.toolchain.nativeSource?.identity ?? null,
    };
  } catch (error) {
    return {
      status: "unknown" as const,
      checkedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function saveActiveDeployment(config: DeploymentConfig, record: DeploymentRecord, rollback = false): void {
  const runtime = rollback ? record.rollbackRuntime : record.runtime;
  const toolchain = rollback ? record.oldToolchain : record.toolchain;
  if (!runtime || !toolchain) throw new Error("active deployment has no verified runtime/toolchain");
  const health = leadRuntimeHealth(config.stateDir, runtime);
  if (!health) throw new DeploymentHeld("active deployment has no current runtime health");
  const active: ActiveDeployment = {
    version: 1,
    configHash: record.configHash,
    source: realpathSync(config.liveSource),
    sourceHash: rollback ? record.oldSourceHash! : record.sourceHash,
    runtime,
    monitorProcesses: monitorProcessReceipts(runtime, health),
    toolchain,
  };
  saveDeploymentJson(join(config.releaseRoot, "active.json"), active);
}

// The parent owns this process group so synchronous filesystem/Git verification is cancellable.
if (import.meta.main) {
  const {
    config,
    active,
    runtime,
  }: {
    config: DeploymentConfig;
    active: ActiveDeployment;
    runtime: RuntimeIdentity;
  } = await Bun.stdin.json();
  try {
    const source = realpathSync(config.liveSource);
    const health = leadRuntimeHealth(config.stateDir, runtime);
    if (
      source !== active.source ||
      !health ||
      !health.configLoaded ||
      realpathSync(health.source) !== source ||
      Date.now() - Date.parse(health.updatedAt) > 5_000 ||
      health.extensionHash !== digest(readFileSync(join(source, "extension/index.ts")))
    )
      throw new DeploymentHeld("current native source observation is absent, stale or different");
    if (sourceManifest(source).hash !== active.sourceHash)
      throw new DeploymentHeld("running source bytes differ from the verified receipt");
    if (!runtimeUsesToolchain(runtime, active.toolchain))
      throw new DeploymentHeld("current native image differs from the verified toolchain");
    assertRuntimeToolchain(config, active.toolchain);
    console.log("null");
  } catch (error) {
    if (!(error instanceof DeploymentHeld)) throw error;
    console.log(JSON.stringify(error.message));
  }
}
