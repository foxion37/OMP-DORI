import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { saveDeploymentJson } from "./deployment-files.ts";
import { actorEnv, command, DeploymentHeld } from "./deployment-process.ts";
import type { DeploymentConfig, DeploymentRecord, ToolchainReceipt } from "./deployment-types.ts";
import { digest } from "./source.ts";

export function assertRuntimeToolchain(config: DeploymentConfig, receipt: ToolchainReceipt): void {
  if (
    receipt.nativeConfig !== join(config.releaseRoot, "native-config.json") ||
    receipt.ompEntry !== realpathSync(receipt.omp) ||
    receipt.ompEntryHash !== digest(readFileSync(receipt.ompEntry)) ||
    receipt.bunHash !== digest(readFileSync(receipt.bun)) ||
    receipt.nativeConfigHash !== digest(readFileSync(receipt.nativeConfig))
  )
    throw new DeploymentHeld("managed native toolchain or per-process update fence changed");
  const overlay = JSON.parse(readFileSync(receipt.nativeConfig, "utf8")) as unknown;
  if (JSON.stringify(overlay) !== JSON.stringify({ update: { auto: false } }))
    throw new DeploymentHeld("managed native update fence differs");
}

/** Query the exact private executable; an admitted prior image may predate the new-release minimum. */
export async function inspectRuntimeToolchain(
  config: DeploymentConfig,
  record: DeploymentRecord,
  omp: string,
  legacy = false,
): Promise<ToolchainReceipt> {
  const nativeConfig = join(config.releaseRoot, "native-config.json");
  const existing = lstatSync(nativeConfig, { throwIfNoEntry: false });
  if (existing) {
    if (
      !existing.isFile() ||
      (existing.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && existing.uid !== process.getuid()) ||
      JSON.stringify(JSON.parse(readFileSync(nativeConfig, "utf8"))) !== JSON.stringify({ update: { auto: false } })
    )
      throw new DeploymentHeld("owned native update fence differs");
  } else saveDeploymentJson(nativeConfig, { update: { auto: false } });
  const home = join(record.directory, legacy ? "legacy-version-home" : "version-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const version = await command(
    [omp, "--config", nativeConfig, "--version"],
    record.directory,
    { ...actorEnv(config), HOME: home },
    15_000,
  );
  const match = /^(?:omp\/|v)?(\d+\.\d+\.\d+)(?:\s|$)/.exec(version);
  if (!match?.[1]) throw new DeploymentHeld("private native OMP version could not be observed");
  const [major, minor, patch] = match[1].split(".").map(Number);
  if (
    !legacy &&
    ((major ?? 0) < 18 || (major === 18 && (minor ?? 0) < 18) || (major === 18 && minor === 18 && (patch ?? 0) < 8))
  )
    throw new DeploymentHeld("private native OMP 18.18.8 or newer is required");
  const ompEntry = realpathSync(omp);
  return {
    omp,
    bun: config.bun,
    nativeVersion: match[1],
    ompEntry,
    ompEntryHash: digest(readFileSync(ompEntry)),
    bunHash: digest(readFileSync(config.bun)),
    nativeConfig,
    nativeConfigHash: digest(readFileSync(nativeConfig)),
  };
}

export async function prepareRuntimeToolchain(config: DeploymentConfig, record: DeploymentRecord): Promise<void> {
  if (record.toolchain) {
    if (record.toolchain.ompEntry !== realpathSync(config.omp) || record.toolchain.bun !== config.bun)
      throw new DeploymentHeld("new release native toolchain differs from its configured target");
    assertRuntimeToolchain(config, record.toolchain);
  } else record.toolchain = await inspectRuntimeToolchain(config, record, config.omp);
}
