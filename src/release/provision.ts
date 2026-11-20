import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { platform } from "../platform/index.ts";
import type { ConsumerPaths } from "./files.ts";
import { consumerPaths, owned, readJson, realDirectory, regularFile, saveJson } from "./files.ts";
import { assertSourceBundle, readSourceBundle } from "./source-bundle.ts";
import { checkoutSourceBundle } from "./source-checkout.ts";
import type { ReleaseManifest } from "./types.ts";

function atLeast(observed: string, minimum: readonly number[]): boolean {
  const numbers = /^(\d+)\.(\d+)\.(\d+)(?:\s|$|\+)/.exec(observed)?.slice(1).map(Number);
  if (!numbers) return false;
  for (let i = 0; i < minimum.length; i++) {
    if (numbers[i] !== minimum[i]) return numbers[i]! > minimum[i]!;
  }
  return true;
}

export function nativeOmp(): string | undefined {
  for (const path of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = Bun.which("omp", { PATH: path });
    if (!candidate) continue;
    const physical = realpathSync(candidate);
    const bases = [dirname(dirname(candidate)), dirname(dirname(physical))];
    if (
      bases.some((base) => {
        const marker = join(base, ".omp-dori");
        // A side home, including a directory alias, is not the source installer's marker file.
        return (
          (lstatSync(marker, { throwIfNoEntry: false }) &&
            !statSync(marker, { throwIfNoEntry: false })?.isDirectory()) ||
          lstatSync(join(base, "releases/consumer-owner.json"), { throwIfNoEntry: false })
        );
      }) ||
      (physical.endsWith("/scripts/consumer/omp") &&
        lstatSync(join(dirname(dirname(dirname(physical))), "native-omp.lock"), { throwIfNoEntry: false }))
    )
      continue;
    return candidate;
  }
  return undefined;
}

export function prerequisites(runtime: string, tools = true, legacyNative = false, paths = consumerPaths()): void {
  if (!platform.supportsReleaseProfile(platform.os, process.arch, runtime))
    throw new Error(`Unsupported release host/runtime: ${platform.os}/${process.arch}/${runtime}`);
  if (!tools) return;
  if (!atLeast(Bun.version, [1, 4, 4])) throw new Error("Bun 1.4.4+ is required; install it before OMP-Dori");
  for (const name of ["git", runtime]) {
    if (!Bun.which(name)) throw new Error(`${name} is required; install it before OMP-Dori`);
  }
  if (legacyNative) {
    const executable = paths.dori === join(paths.home, ".dori") ? Bun.which("omp") : nativeOmp();
    if (!executable) throw new Error("Older release protocol requires an independently installed OMP 18.18.8+");
    if (paths.dori === join(paths.home, ".dori")) {
      const managed = join(paths.dori, "bin/omp");
      if (lstatSync(managed, { throwIfNoEntry: false })) {
        const target = realpathSync(managed);
        const config = regularFile(paths.config) ? readJson(paths.config) : undefined;
        const command =
          config && typeof config === "object" && "agentCommand" in config && Array.isArray(config.agentCommand)
            ? config.agentCommand[0]
            : undefined;
        const configured = typeof command === "string" ? Bun.which(command) : undefined;
        if (realpathSync(executable) === target || (configured && realpathSync(configured) === target))
          throw new Error(
            "Older release protocol requires an independently installed OMP 18.18.8+; managed omp is removed during activation",
          );
      }
    }
    const omp = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const version = omp.stdout.toString().match(/\d+\.\d+\.\d+(?:[-+][^\s]+)?/)?.[0] ?? "";
    if (omp.exitCode !== 0 || !atLeast(version, [18, 18, 8]))
      throw new Error("Older release protocol requires OMP 18.18.8+");
  }
}

async function git(args: readonly string[], cwd: string, home: string): Promise<string> {
  // Limit only this child's creation mask; never chmod or change the caller's existing checkout.
  const proc = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      'umask 077; exec "$@"',
      "dori-dependency-git",
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "gc.auto=0",
      ...args,
    ],
    {
      cwd,
      env: {
        HOME: home,
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 300_000,
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`Pinned public dependency Git operation failed: ${stderr.trim()}`);
  return stdout.trim();
}

export function dependencyPlan(paths: ConsumerPaths, manifest: ReleaseManifest, source?: string) {
  const { commit, repository } = manifest.ompUlw;
  const bundle = manifest.requirements.omp === "18.20.0" ? readSourceBundle(source!, false) : undefined;
  if (bundle && (bundle.lock.commit !== commit || bundle.lock.repository !== repository))
    throw new Error("Release overlay differs from its upstream dependency pin");
  const dependency = join(paths.dependencies, `omp-ulw-${commit}${bundle ? `-${bundle.identity}` : ""}`);
  const expected = { version: 1, repository, commit, ...(bundle ? { identity: bundle.identity } : {}) };
  return { bundle, directory: dependency, expected };
}

/** Existing dependency checkouts are never reset, fetched into, or otherwise modified. */
export async function provisionDependency(
  paths: ConsumerPaths,
  manifest: ReleaseManifest,
  source?: string,
): Promise<string> {
  const { commit, repository } = manifest.ompUlw;
  const { bundle, directory: dependency, expected } = dependencyPlan(paths, manifest, source);
  const receipt = `${dependency}.json`;
  const verify = async () => {
    realDirectory(dependency);
    owned(dependency);
    realDirectory(join(dependency, ".git"));
    if (JSON.stringify(readJson(receipt)) !== JSON.stringify(expected))
      throw new Error("Pinned dependency ownership receipt differs; existing checkout left untouched");
    if ((await git(["rev-parse", "HEAD"], dependency, paths.staging)) !== commit)
      throw new Error("Pinned dependency HEAD differs; existing checkout left untouched");
    if (bundle) assertSourceBundle(dependency, bundle, paths.home);
    else if (
      (await git(["status", "--porcelain", "--untracked-files=all", "--ignored"], dependency, paths.staging)) !== ""
    )
      throw new Error("Pinned dependency checkout changed; existing files left untouched");
    if (!regularFile(join(dependency, "index.ts"))) throw new Error("Pinned dependency has no real index.ts");
  };
  if (lstatSync(dependency, { throwIfNoEntry: false })) {
    await verify();
    return join(dependency, "index.ts");
  }
  const stage = mkdtempSync(join(paths.staging, "dependency-"));
  const checkout = join(stage, "checkout");
  try {
    if (bundle) await checkoutSourceBundle(checkout, bundle, stage);
    else {
      mkdirSync(checkout, { mode: 0o700 });
      await git(["init", "--quiet", checkout], stage, stage);
      await git(["fetch", "--quiet", "--depth=1", "--no-tags", "--", repository, commit], checkout, stage);
      await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", commit], checkout, stage);
      if ((await git(["rev-parse", "HEAD"], checkout, stage)) !== commit)
        throw new Error("Fetched public dependency does not match its exact lock SHA");
    }
    if (!regularFile(join(checkout, "index.ts"))) throw new Error("Fetched dependency has no real index.ts");
    if (regularFile(receipt) && JSON.stringify(readJson(receipt)) !== JSON.stringify(expected))
      throw new Error("Pinned dependency receipt collision");
    saveJson(receipt, expected);
    renameSync(checkout, dependency);
    await verify();
    return join(dependency, "index.ts");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function assertLock(source: string, manifest: ReleaseManifest): void {
  if (readFileSync(join(source, "omp-ulw.lock"), "utf8").trim() !== manifest.ompUlw.commit)
    throw new Error("Release omp-ulw.lock differs from its declared public pin");
  if (manifest.requirements.omp === "18.20.0") {
    const overlay = readSourceBundle(source);
    const native = readSourceBundle(source, true);
    if (overlay.lock.commit !== manifest.ompUlw.commit || native.lock.nativeVersion !== manifest.requirements.omp)
      throw new Error("Release source bundle differs from its declared native or ULW identity");
  }
}
