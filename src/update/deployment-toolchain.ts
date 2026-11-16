import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assertNativeSource, provisionNativeSource, type NativeReceipt } from "../release/native.ts";
import { assertSourceBundle, readSourceBundle } from "../release/source-bundle.ts";
import { provisionSourceOverlay } from "../release/source-checkout.ts";
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
  if (receipt.nativeSource) {
    const observed = assertNativeSource(receipt.nativeSource.source, config.home, receipt.bun);
    if (
      observed.identity !== receipt.nativeSource.identity ||
      observed.omp !== receipt.omp ||
      JSON.stringify(observed) !== JSON.stringify(receipt.nativeSource)
    )
      throw new DeploymentHeld("managed bound native source receipt changed");
  }
  if (receipt.ompUlw) {
    const bundle = readSourceBundle(receipt.ompUlw.source);
    if (bundle.identity !== receipt.ompUlw.identity) throw new DeploymentHeld("managed ULW overlay identity changed");
    assertSourceBundle(receipt.ompUlw.directory, bundle, config.home);
  }
}

/** Query the exact private executable; an admitted prior image may predate the new-release minimum. */
export async function inspectRuntimeToolchain(
  config: DeploymentConfig,
  record: DeploymentRecord,
  omp: string,
  legacy = false,
  nativeSource?: NativeReceipt,
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
  if (
    !legacy &&
    lstatSync(join(record.releasePath, "native-omp.lock"), { throwIfNoEntry: false }) &&
    match[1] !== "18.20.0"
  )
    throw new DeploymentHeld("new source bundles require native OMP 18.20.0");
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
    ...(nativeSource
      ? { nativeSource }
      : !legacy && lstatSync(join(record.releasePath, "native-omp.lock"), { throwIfNoEntry: false })
        ? { nativeOverride: true as const }
        : {}),
  };
}

export async function prepareRuntimeToolchain(config: DeploymentConfig, record: DeploymentRecord): Promise<void> {
  const locked = lstatSync(join(record.releasePath, "native-omp.lock"), { throwIfNoEntry: false }) !== undefined;
  const bundle = locked ? readSourceBundle(record.releasePath, true) : undefined;
  if (record.toolchain) {
    if (
      record.toolchain.bun !== config.bun ||
      (config.omp && record.toolchain.ompEntry !== realpathSync(config.omp)) ||
      (locked && !config.omp && record.toolchain.nativeSource?.identity !== bundle?.identity) ||
      (locked && config.omp && !record.toolchain.nativeOverride) ||
      (locked && record.toolchain.ompUlw?.identity !== readSourceBundle(record.releasePath).identity)
    )
      throw new DeploymentHeld("new release native toolchain differs from its configured target");
    assertRuntimeToolchain(config, record.toolchain);
    return;
  }
  const native =
    locked && !config.omp ? await provisionNativeSource(record.releasePath, config.home, config.bun) : undefined;
  const omp = native?.omp ?? config.omp;
  if (!omp) throw new DeploymentHeld("older source protocol needs its explicit native executable");
  record.toolchain = await inspectRuntimeToolchain(config, record, omp, false, native);
  if (locked) {
    const entry = await provisionSourceOverlay(record.releasePath, config.home);
    record.toolchain = {
      ...record.toolchain,
      ompUlw: {
        source: record.releasePath,
        identity: readSourceBundle(record.releasePath).identity,
        directory: join(entry, ".."),
      },
    };
  }
}
