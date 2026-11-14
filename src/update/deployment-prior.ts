import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ActiveDeployment } from "./deployment-active.ts";
import { DeploymentHeld, sameProcess } from "./deployment-process.ts";
import { assertRuntimeToolchain, inspectRuntimeToolchain, prepareRuntimeToolchain } from "./deployment-toolchain.ts";
import type { DeploymentConfig, DeploymentRecord, RuntimeIdentity, ToolchainReceipt } from "./deployment-types.ts";
import { digest } from "./source.ts";

export function runtimeUsesToolchain(runtime: RuntimeIdentity, receipt: ToolchainReceipt): boolean {
  if (runtime.executableHash === receipt.ompEntryHash) return true;
  if (runtime.executableHash !== receipt.bunHash) return false;
  const argv = readFileSync(`/proc/${runtime.pid}/cmdline`, "utf8").split("\0");
  return argv.some((arg) => {
    if (!isAbsolute(arg)) return false;
    try {
      return realpathSync(arg) === receipt.ompEntry;
    } catch {
      return false;
    }
  });
}

export function verifyLegacyArtifact(config: DeploymentConfig, expectedHash: string): string {
  if (
    !config.legacyOmp ||
    !lstatSync(config.liveSource).isDirectory() ||
    digest(readFileSync(config.legacyOmp)) !== expectedHash
  )
    throw new DeploymentHeld("legacy native override differs from the captured running image or source generation");
  return config.legacyOmp;
}

/** A prior managed receipt outranks a legacy override. Legacy images are admitted only for the first directory conversion. */
export async function admitRuntimeToolchains(
  config: DeploymentConfig,
  record: DeploymentRecord,
  runtime: RuntimeIdentity,
  active: ActiveDeployment | undefined,
  converting: boolean,
): Promise<RuntimeIdentity> {
  if (!runtime.executableHash) throw new DeploymentHeld("prior native executable hash is unavailable");
  const sameActor =
    active &&
    active.runtime.sessionId === runtime.sessionId &&
    active.runtime.sessionFile === runtime.sessionFile &&
    active.runtime.startedAt === runtime.startedAt &&
    sameProcess(active.runtime, runtime);
  if (active && sameActor && (active.source !== record.oldSource || active.sourceHash !== record.oldSourceHash))
    throw new DeploymentHeld("prior managed source changed after its verified runtime receipt");
  const prior = active && sameActor ? active.toolchain : undefined;
  if (prior) {
    assertRuntimeToolchain(config, prior);
    if (!runtimeUsesToolchain(runtime, prior))
      throw new DeploymentHeld("prior managed native receipt no longer matches its actor");
    record.oldToolchain = prior;
    if (!converting) record.toolchain = prior;
  }
  if (converting || !record.toolchain) await prepareRuntimeToolchain(config, record);
  if (!record.oldToolchain) {
    if (converting && lstatSync(config.liveSource).isDirectory() && config.legacyOmp) {
      const legacy = verifyLegacyArtifact(config, runtime.executableHash);
      record.oldToolchain = await inspectRuntimeToolchain(config, record, legacy, true);
    } else if (record.toolchain && runtimeUsesToolchain(runtime, record.toolchain))
      record.oldToolchain = record.toolchain;
    else throw new DeploymentHeld("legacy native conversion needs its exact preserved executable before any stop");
  }
  const oldToolchain = record.oldToolchain;
  if (!oldToolchain) throw new DeploymentHeld("prior native toolchain receipt is unavailable");
  assertRuntimeToolchain(config, oldToolchain);
  if (!runtimeUsesToolchain(runtime, oldToolchain))
    throw new DeploymentHeld("rollback native image differs from the captured actor");
  return {
    ...runtime,
    nativeVersion: oldToolchain.nativeVersion,
    entrypointHash: oldToolchain.ompEntryHash,
  };
}
