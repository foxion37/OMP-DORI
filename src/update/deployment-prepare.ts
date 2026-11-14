import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { command, DeploymentHeld } from "./deployment-process.ts";
import type { DeploymentConfig, DeploymentInput, DeploymentRecord } from "./deployment-types.ts";
import { assertSourceAdmission, digest, sameManifest, sourceManifest } from "./source.ts";

import { hasControl } from "./config.ts";

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const PUBLIC = (path: string): boolean => path !== "ref/omp-ulw" && !path.startsWith("ref/omp-ulw/");
const SAFE_GIT = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0"];

export function validateDeploymentInput(input: DeploymentInput): void {
  if (!SHA.test(input.commit) || !SHA.test(input.tree) || !/^[a-f0-9]{64}$/.test(input.sourceHash))
    throw new DeploymentHeld("published release identity is invalid");
  if (
    !input.remote ||
    hasControl(input.remote) ||
    (/^[a-z]+:\/\//i.test(input.remote) &&
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(input.remote))
  )
    throw new DeploymentHeld("published remote must be local Git or credential-free GitHub HTTPS");
  const manifest = input.publicManifest;
  if (
    manifest.version !== 1 ||
    manifest.ulwPresent === true ||
    !manifest.files.length ||
    manifest.files.some(
      (file) =>
        !PUBLIC(file.path) ||
        file.path.startsWith("/") ||
        hasControl(file.path) ||
        file.path.split("/").some((part) => !part || part === "." || part === "..") ||
        !/^[a-f0-9]{64}$/.test(file.sha256),
    )
  )
    throw new DeploymentHeld("published source manifest is invalid");
  if (digest(JSON.stringify({ files: manifest.files, ulwPresent: manifest.ulwPresent })) !== manifest.hash)
    throw new DeploymentHeld("published source manifest digest differs");
  const candidate = sourceManifest(input.candidate);
  assertSourceAdmission(candidate, "candidate");
  if (
    candidate.hash !== input.sourceHash ||
    JSON.stringify(candidate.files.filter((file) => PUBLIC(file.path))) !== JSON.stringify(manifest.files)
  )
    throw new DeploymentHeld("candidate no longer matches the reviewed published source");
}

/** Ordinary detached clone of the published commit. No candidate Git metadata or operator HOME is copied. */
export async function prepareRelease(
  config: DeploymentConfig,
  input: DeploymentInput,
  record: DeploymentRecord,
  signal?: AbortSignal,
): Promise<void> {
  validateDeploymentInput(input);
  mkdirSync(record.directory, { recursive: true, mode: 0o700 });
  const home = join(record.directory, "prepare-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = {
    HOME: home,
    PATH: `${dirname(config.bun)}:/usr/bin:/bin`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    BUN_INSTALL_CACHE_DIR: join(record.directory, "bun-cache"),
    DORI_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  };
  const git = (argv: readonly string[], cwd = record.releasePath): Promise<string> =>
    command([...SAFE_GIT, ...argv], cwd, env, 300_000, signal);
  const release = lstatSync(record.releasePath, { throwIfNoEntry: false });
  if (!release)
    await git(["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--", input.remote, record.releasePath], home);
  else if (!release.isDirectory() || !lstatSync(join(record.releasePath, ".git")).isDirectory())
    throw new DeploymentHeld("interrupted release has no owned ordinary clone");
  if (!record.preparedAt) {
    await git(["fetch", "--no-auto-maintenance", "--no-tags", "origin", input.commit]);
    await git(["checkout", "--detach", input.commit]);
  }
  if ((await git(["rev-parse", "HEAD"])) !== input.commit || (await git(["rev-parse", "HEAD^{tree}"])) !== input.tree)
    throw new DeploymentHeld("published commit or tree readback differs");
  const entries = (await git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"])).split("\0").filter(Boolean);
  const paths = entries.map((entry) => /^(100644|100755) blob [a-f0-9]+\t(.+)$/.exec(entry)?.[2]);
  if (
    paths.some((path) => path === undefined) ||
    JSON.stringify(paths.sort()) !== JSON.stringify(input.publicManifest.files.map((file) => file.path).sort())
  )
    throw new DeploymentHeld("published tree contains source outside its admitted manifest");
  const observed = sourceManifest(record.releasePath);
  if (JSON.stringify(observed.files.filter((file) => PUBLIC(file.path))) !== JSON.stringify(input.publicManifest.files))
    throw new DeploymentHeld("published release bytes or executable modes differ");
  const candidate = sourceManifest(input.candidate);
  for (const file of candidate.files.filter((entry) => !PUBLIC(entry.path))) {
    const destination = join(record.releasePath, file.path);
    if (lstatSync(destination, { throwIfNoEntry: false })) {
      const stat = lstatSync(destination);
      if (
        !stat.isFile() ||
        digest(readFileSync(destination)) !== file.sha256 ||
        ((stat.mode & 0o111) !== 0) !== file.executable
      )
        throw new DeploymentHeld("interrupted opaque pin differs");
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(join(input.candidate, file.path), destination);
    chmodSync(destination, file.executable ? 0o755 : 0o644);
  }
  if (candidate.ulwPresent) mkdirSync(join(record.releasePath, "ref/omp-ulw"), { recursive: true, mode: 0o700 });
  if (!sameManifest(sourceManifest(record.releasePath), candidate))
    throw new DeploymentHeld("release lost the frozen opaque pin");
  if (record.preparedAt) return;
  const version = await command([config.bun, "--version"], home, env, 10_000, signal);
  const numbers = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (
    !numbers ||
    (numbers[0] ?? 0) < 1 ||
    (numbers[0] === 1 && (numbers[1] ?? 0) < 4) ||
    (numbers[0] === 1 && numbers[1] === 4 && (numbers[2] ?? 0) < 4)
  )
    throw new DeploymentHeld("private Bun 1.4.4 or newer is required");
  for (const relative of ["", "skills/dori-mode/scripts", "extension"]) {
    for (const name of ["package.json", "bun.lock"]) {
      if (!input.publicManifest.files.some((file) => file.path === (relative ? `${relative}/${name}` : name)))
        throw new DeploymentHeld("published release lacks a frozen dependency manifest");
    }
    await command(
      [config.bun, "install", "--frozen-lockfile", "--ignore-scripts", "--silent"],
      join(record.releasePath, relative),
      env,
      300_000,
      signal,
    );
  }
  validateDeploymentInput(input);
  if (!sameManifest(sourceManifest(record.releasePath), candidate))
    throw new DeploymentHeld("provisioning changed reviewed source");
  for (const file of candidate.files) chmodSync(join(record.releasePath, file.path), file.executable ? 0o555 : 0o444);
}
