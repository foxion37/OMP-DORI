import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ActiveDeployment } from "./deployment-active.ts";
import { DeploymentHeld, managedOmpCommand, sameProcess } from "./deployment-process.ts";
import { assertRuntimeToolchain, prepareRuntimeToolchain } from "./deployment-toolchain.ts";
import type { DeploymentConfig, DeploymentRecord, RuntimeIdentity, ToolchainReceipt } from "./deployment-types.ts";
import { procCmdline } from "./proc.ts";

export function runtimeUsesToolchain(runtime: RuntimeIdentity, receipt: ToolchainReceipt): boolean {
  if (runtime.executableHash === receipt.ompEntryHash) return true;
  if (runtime.executableHash !== receipt.bunHash) return false;
  const argv = procCmdline(runtime.pid).split("\0");
  return argv.some((arg) => {
    if (!isAbsolute(arg)) return false;
    try {
      return realpathSync(arg) === (receipt.nativeSource?.entry ?? receipt.ompEntry);
    } catch {
      return false;
    }
  });
}

/** Rollback relaunches the prior source with its own pinned extension. */
function priorSourceToolchain(toolchain: ToolchainReceipt, source: string | undefined): ToolchainReceipt {
  if (source === toolchain.extensionSource) return toolchain;
  if (source === undefined) throw new DeploymentHeld("prior source cannot be relaunched with the pinned extension");
  return { ...toolchain, extensionSource: source };
}

/** A prior managed receipt outranks the prepared one; without it the running lead must already use the prepared image. */
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
    if (!record.toolchain || !runtimeUsesToolchain(runtime, record.toolchain))
      throw new DeploymentHeld(
        "running native lead has no managed toolchain receipt and differs from the prepared one",
      );
    record.oldToolchain = priorSourceToolchain(record.toolchain, record.oldSource);
  }
  const oldToolchain = record.oldToolchain;
  if (!oldToolchain) throw new DeploymentHeld("prior native toolchain receipt is unavailable");
  assertRuntimeToolchain(config, oldToolchain);
  // Rollback relaunches the prior source with this receipt; prove that command exists before the old actor stops.
  managedOmpCommand(oldToolchain, record.oldSource);
  if (!runtimeUsesToolchain(runtime, oldToolchain))
    throw new DeploymentHeld("rollback native image differs from the captured actor");
  return {
    ...runtime,
    nativeVersion: oldToolchain.nativeVersion,
    entrypointHash: oldToolchain.ompEntryHash,
  };
}
