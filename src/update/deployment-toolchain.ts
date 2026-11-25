import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assertNativeSource, leaseNativePath, provisionNativeSource, type NativeReceipt } from "../release/native.ts";
import { readSourceBundle } from "../release/source-bundle.ts";
import { saveDeploymentJson } from "./deployment-files.ts";
import { actorEnv, command, DeploymentHeld } from "./deployment-process.ts";
import type { DeploymentConfig, DeploymentRecord, ToolchainReceipt } from "./deployment-types.ts";
import { digest } from "./source.ts";

export function assertRuntimeToolchain(config: DeploymentConfig, receipt: ToolchainReceipt): void {
  // Leased before anything is read, so a native cache prune keeps it or has finished.
  leaseNativePath(config.home, receipt.omp);
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
  if (receipt.nativeSource) {
    const observed = assertNativeSource(receipt.nativeSource.source, config.home, receipt.bun, {
      directory: receipt.nativeSource.directory,
    });
    if (
      observed.identity !== receipt.nativeSource.identity ||
      observed.omp !== receipt.omp ||
      JSON.stringify(observed) !== JSON.stringify(receipt.nativeSource)
    )
      throw new DeploymentHeld("managed bound native source receipt changed");
  }
}

/** Query the exact private executable against the release's locked native version. */
export async function inspectRuntimeToolchain(
  config: DeploymentConfig,
  record: DeploymentRecord,
  omp: string,
  nativeSource?: NativeReceipt,
): Promise<Omit<ToolchainReceipt, "extensionSource">> {
  // Direct prior-image inspection also verifies and records an explicit executable inside the cache.
  leaseNativePath(config.home, omp);
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
  const home = join(record.directory, "version-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const version = await command(
    [omp, "--config", nativeConfig, "--version"],
    record.directory,
    { ...actorEnv(config), HOME: home },
    15_000,
  );
  const match = /^(?:omp\/|v)?(\d+\.\d+\.\d+)(?:\s|$)/.exec(version);
  if (!match?.[1]) throw new DeploymentHeld("private native OMP version could not be observed");
  const required = readSourceBundle(record.releasePath).lock.nativeVersion;
  if (match[1] !== required) throw new DeploymentHeld(`new source bundles require native OMP ${required}`);
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
    ...(nativeSource ? { nativeSource } : { nativeOverride: true as const }),
  };
}

export async function prepareRuntimeToolchain(config: DeploymentConfig, record: DeploymentRecord): Promise<void> {
  if (record.toolchain) {
    if (
      record.toolchain.bun !== config.bun ||
      (config.omp && record.toolchain.ompEntry !== realpathSync(config.omp)) ||
      (!config.omp && record.toolchain.nativeSource?.identity !== readSourceBundle(record.releasePath).identity) ||
      (config.omp && !record.toolchain.nativeOverride)
    )
      throw new DeploymentHeld("new release native toolchain differs from its configured target");
    assertRuntimeToolchain(config, record.toolchain);
    return;
  }
  const { omp } = config;
  const toolchain = omp
    ? await inspectRuntimeToolchain(config, record, omp)
    : await provisionNativeSource(record.releasePath, config.home, config.bun).then((native) =>
        inspectRuntimeToolchain(config, record, native.omp, native),
      );
  record.toolchain = { ...toolchain, extensionSource: record.releasePath };
}
