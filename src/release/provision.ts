import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ConsumerPaths } from "./files.ts";
import { owned, readJson, realDirectory, regularFile, saveJson } from "./files.ts";
import type { ReleaseManifest } from "./types.ts";

function atLeast(observed: string, minimum: readonly number[]): boolean {
  const numbers = /^(\d+)\.(\d+)\.(\d+)(?:\s|$|\+)/.exec(observed)?.slice(1).map(Number);
  if (!numbers) return false;
  for (let i = 0; i < minimum.length; i++) {
    if (numbers[i] !== minimum[i]) return numbers[i]! > minimum[i]!;
  }
  return true;
}

export function prerequisites(): void {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("This release supports Linux x64 with herdr and Discord");
  if (!atLeast(Bun.version, [1, 4, 4])) throw new Error("Bun 1.4.4+ is required; install it before OMP-Dori");
  for (const name of ["git", "omp", "herdr"]) {
    if (!Bun.which(name)) throw new Error(`${name} is required; install it before OMP-Dori`);
  }
  const omp = Bun.spawnSync(["omp", "--version"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const version = omp.stdout.toString().match(/\d+\.\d+\.\d+(?:[-+][^\s]+)?/)?.[0] ?? "";
  if (omp.exitCode !== 0 || !atLeast(version, [18, 18, 8])) throw new Error("OMP 18.18.8+ is required");
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

/** Existing dependency checkouts are never reset, fetched into, or otherwise modified. */
export async function provisionDependency(paths: ConsumerPaths, manifest: ReleaseManifest): Promise<string> {
  const { commit, repository } = manifest.ompUlw;
  const dependency = join(paths.dependencies, `omp-ulw-${commit}`);
  const receipt = `${dependency}.json`;
  const expected = { version: 1, repository, commit };
  const verify = async () => {
    realDirectory(dependency);
    owned(dependency);
    realDirectory(join(dependency, ".git"));
    if (JSON.stringify(readJson(receipt)) !== JSON.stringify(expected))
      throw new Error("Pinned dependency ownership receipt differs; existing checkout left untouched");
    if ((await git(["rev-parse", "HEAD"], dependency, paths.staging)) !== commit)
      throw new Error("Pinned dependency HEAD differs; existing checkout left untouched");
    if ((await git(["status", "--porcelain", "--untracked-files=all", "--ignored"], dependency, paths.staging)) !== "")
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
    mkdirSync(checkout, { mode: 0o700 });
    await git(["init", "--quiet", checkout], stage, stage);
    await git(["fetch", "--quiet", "--depth=1", "--no-tags", "--", repository, commit], checkout, stage);
    await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", commit], checkout, stage);
    if ((await git(["rev-parse", "HEAD"], checkout, stage)) !== commit)
      throw new Error("Fetched public dependency does not match its exact lock SHA");
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
}
