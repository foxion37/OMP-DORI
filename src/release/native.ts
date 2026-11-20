import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { platform } from "../platform/index.ts";
import { shq } from "../delivery.ts";
import { command } from "../update/deployment-process.ts";
import { digest } from "../update/source.ts";
import { fileDigest, owned, readJson, realDirectory, regularFile, saveJson } from "./files.ts";
import { leaseNativeIdentity, nativeStagePrefix } from "./native-cache-lease.ts";
import { assertNativeExport } from "./native-export.ts";
import { assertSourceBundle, bundleEnv, readSourceBundle } from "./source-bundle.ts";
import { checkoutSourceBundle } from "./source-checkout.ts";

export type NativeReceipt = {
  readonly version: 1;
  readonly source: string;
  readonly identity: string;
  readonly directory: string;
  readonly omp: string;
  readonly ompHash: string;
  readonly entry: string;
  readonly bun: string;
  readonly bunHash: string;
  readonly addonLockHash: string;
  readonly addon: string;
  readonly addonHash: string;
};
const LAUNCHER = "packages/coding-agent/scripts/omp";
export function nativeDirectory(source: string, home: string): string {
  return join(home, ".cache/omp-dori", `${platform.nativeCacheLabel()}-${readSourceBundle(source, true).identity}`);
}

/**
 * Lease the identity an explicitly chosen executable lies in (by its own path or once resolved), so a writer that
 * publishes it (a wrapper, a deployment record) holds it like one that prepared it. Then the executable must still be
 * there: a prune may have removed it before the lease. Paths outside the cache lease nothing.
 */
export function leaseNativePath(home: string, path: string, holder = process.pid): void {
  const cache = join(home, ".cache/omp-dori");
  const entry = new RegExp(`^${platform.nativeCacheLabel()}-([a-f0-9]{64})$`);
  const inside = (candidate: string, root: string) =>
    candidate.startsWith(`${root}/`) ? entry.exec(candidate.slice(root.length + 1).split("/", 1)[0]!)?.[1] : undefined;
  const real = (candidate: string) => {
    try {
      return realpathSync(candidate);
    } catch {
      return candidate;
    }
  };
  const identities = new Set(
    [inside(path, cache), inside(real(path), cache), inside(real(path), real(cache))].filter((id) => id !== undefined),
  );
  for (const identity of identities) leaseNativeIdentity(home, identity, holder);
  if (identities.size && !lstatSync(real(path), { throwIfNoEntry: false })?.isFile())
    throw new Error(`Selected native executable ${path} is gone from the native cache; prepare it again`);
}

/** The cache launcher always validates source then execs the protected upstream launcher through the recorded Bun. */
export function nativeLauncher(source: string, home: string, directory: string, bun: string): string {
  return `#!/bin/sh\nset -eu\nunset PI_COMPILED __PI_NATIVE_VARIANT_CACHE\nexport PATH=${shq(join(directory, "bin"))}:"$PATH"\nexport PI_NATIVES_DIR=${shq(join(directory, "natives"))}\nexport OMP_DEV_LAUNCH_DIR=${shq(join(directory, "launch-cwd"))}\nlaunch_cwd=$PWD\ncd "$OMP_DEV_LAUNCH_DIR"\n${shq(bun)} ${shq(join(source, "scripts/source-dependencies.ts"))} assert-native ${shq(source)} ${shq(home)} >/dev/null\ncd "$launch_cwd"\nexec ${shq(join(directory, "source", LAUNCHER))} --config ${shq(join(directory, "native-config.json"))} "$@"\n`;
}

/**
 * Recompute source identity and every tracked postimage independently of the native release stamp. `holder` leases the
 * identity first (see `leaseNativeIdentity`): the process that goes on to use it, or the shell that will exec it.
 */
export function assertNativeSource(
  source: string,
  home: string,
  bun = process.execPath,
  holder = process.pid,
): NativeReceipt {
  const bundle = readSourceBundle(source, true);
  leaseNativeIdentity(home, bundle.identity, holder);
  const directory = nativeDirectory(source, home);
  const receipt = readJson(join(directory, "receipt.json")) as NativeReceipt;
  const checkout = join(directory, "source");
  if (
    bundle.lock.launcher !== LAUNCHER ||
    !receipt ||
    receipt.version !== 1 ||
    receipt.identity !== bundle.identity ||
    receipt.directory !== directory ||
    receipt.omp !== join(directory, "bin/omp") ||
    !regularFile(receipt.omp) ||
    (lstatSync(receipt.omp).mode & 0o111) === 0 ||
    JSON.stringify(readJson(join(directory, "native-config.json"))) !== JSON.stringify({ update: { auto: false } }) ||
    typeof receipt.source !== "string" ||
    nativeDirectory(receipt.source, home) !== directory ||
    receipt.ompHash !== digest(nativeLauncher(receipt.source, home, directory, receipt.bun)) ||
    receipt.entry !== join(checkout, "packages/coding-agent/src/cli.ts") ||
    receipt.bun !== realpathSync(bun) ||
    receipt.bunHash !== fileDigest(bun) ||
    receipt.ompHash !== digest(readFileSync(receipt.omp)) ||
    receipt.addonLockHash !== digest(readFileSync(join(source, "native-addon/bun.lock"))) ||
    !regularFile(receipt.addon) ||
    receipt.addonHash !== fileDigest(receipt.addon) ||
    receipt.addon !== join(checkout, "packages/natives/native", basename(receipt.addon)) ||
    realpathSync(join(directory, "bin/bun")) !== receipt.bun ||
    !regularFile(join(checkout, LAUNCHER)) ||
    (lstatSync(join(checkout, LAUNCHER)).mode & 0o111) === 0 ||
    readdirSync(join(checkout, "packages/natives/native"))
      .filter((name) => name.endsWith(".node"))
      .join() !== basename(receipt.addon) ||
    readdirSync(join(directory, "launch-cwd")).length !== 0
  )
    throw new Error("Bound native source, Bun, addon or launcher receipt differs");
  assertSourceBundle(checkout, bundle, home);
  assertNativeExport(checkout);
  return receipt;
}

async function probe(loader: string, cwd: string, home: string, bun: string, natives: string): Promise<string> {
  const code = `const m = await import(process.argv[1]); const b = m.loadNative();
if (typeof b.__piNativesBuildVersion !== "function" || b.__piNativesBuildVersion() !== "18.20.0") throw new Error("official native addon version differs");
const s = m.nativeAddonStatus(); if (!s || s.version !== "18.20.0" || s.stale) throw new Error("native addon identity unavailable"); console.log(s.path);`;
  return command([bun, "-e", code, loader], cwd, { ...bundleEnv(home, bun), PI_NATIVES_DIR: natives }, 60_000);
}

/** Frozen official addon reuse changes no Rust code and makes no compiled-binary equivalence claim. */
export async function provisionNativeSource(
  source: string,
  home: string,
  bun = process.execPath,
  holder = process.pid,
): Promise<NativeReceipt> {
  source = realpathSync(source);
  bun = realpathSync(bun);
  const bundle = readSourceBundle(source, true);
  if (bundle.lock.launcher !== LAUNCHER)
    throw new Error("Native bundle must use the protected upstream omp source launcher");
  // Leased before the existence check, so a prune either keeps this identity or has finished before it is looked at.
  leaseNativeIdentity(home, bundle.identity, holder);
  const directory = nativeDirectory(source, home);
  if (lstatSync(directory, { throwIfNoEntry: false })) return assertNativeSource(source, home, bun, holder);
  const cache = join(home, ".cache/omp-dori");
  realDirectory(cache, true);
  owned(cache);
  // The stage names its identity and owner, so a prune can tell one whose owner was killed (Bun skips finally on a signal).
  const stage = mkdtempSync(join(cache, nativeStagePrefix(bundle.identity)));
  const checkout = join(stage, "source");
  const addon = join(stage, "addon");
  const natives = join(stage, "natives");
  try {
    await checkoutSourceBundle(checkout, bundle, stage);
    for (const path of [addon, natives, join(stage, "bin"), join(stage, "launch-cwd")])
      mkdirSync(path, { mode: 0o700 });
    for (const name of ["package.json", "bun.lock"]) {
      copyFileSync(join(source, "native-addon", name), join(addon, name));
      chmodSync(join(addon, name), 0o600);
    }
    for (const cwd of [checkout, addon])
      await command(
        [
          "/bin/sh",
          "-c",
          'umask 077; exec "$@"',
          "dori-native-install",
          bun,
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--silent",
        ],
        cwd,
        bundleEnv(home, bun),
        300_000,
      );
    for (const name of ["package.json", "bun.lock"])
      if (digest(readFileSync(join(addon, name))) !== digest(readFileSync(join(source, "native-addon", name))))
        throw new Error("Frozen official addon dependency metadata changed during installation");
    assertSourceBundle(checkout, bundle, home);
    await command(
      [
        "/bin/sh",
        "-c",
        'umask 077; exec "$@"',
        "dori-native-export",
        bun,
        "packages/collab-web/scripts/build-export-viewer.ts",
        "--check",
      ],
      checkout,
      bundleEnv(home, bun),
      300_000,
    );
    const official = await probe(
      join(addon, "node_modules/@oh-my-pi/pi-natives/native/loader-state.js"),
      stage,
      home,
      bun,
      natives,
    );
    if (
      !regularFile(official) ||
      !realpathSync(official).startsWith(`${realpathSync(join(addon, "node_modules"))}/`) ||
      !official.endsWith(".node")
    )
      throw new Error("Official native package resolved an addon outside its frozen install");
    const target = join(checkout, "packages/natives/native", basename(official));
    copyFileSync(official, target);
    if (
      resolve(await probe(join(checkout, "packages/natives/native/loader-state.js"), stage, home, bun, natives)) !==
      target
    )
      throw new Error("Bound source did not load the exact version-matched official addon");
    symlinkSync(bun, join(stage, "bin/bun"));
    const launcher = nativeLauncher(source, home, directory, bun);
    writeFileSync(join(stage, "bin/omp"), launcher, { mode: 0o700 });
    chmodSync(join(stage, "bin/omp"), 0o700);
    const receipt: NativeReceipt = {
      version: 1,
      source,
      identity: bundle.identity,
      directory,
      omp: join(directory, "bin/omp"),
      ompHash: digest(launcher),
      entry: join(directory, "source/packages/coding-agent/src/cli.ts"),
      bun,
      bunHash: fileDigest(bun),
      addonLockHash: digest(readFileSync(join(source, "native-addon/bun.lock"))),
      addon: join(directory, "source/packages/natives/native", basename(official)),
      addonHash: fileDigest(target),
    };
    assertSourceBundle(checkout, bundle, home);
    saveJson(join(stage, "native-config.json"), { update: { auto: false } });
    saveJson(join(stage, "receipt.json"), receipt);
    renameSync(stage, directory);
    return assertNativeSource(source, home, bun, holder);
  } finally {
    if (lstatSync(stage, { throwIfNoEntry: false })) rmSync(stage, { recursive: true, force: true });
  }
}
