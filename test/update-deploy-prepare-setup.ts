import { afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import type { DeploymentInput, DeploymentRecord } from "../src/update/deployment-types.ts";
import { sourceManifest } from "../src/update/source.ts";
import { git } from "./update-setup.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
/** `published` adds tracked files to the published commit, e.g. a Cargo crate whose native host preparation builds. */
export function preparationFixture(published: Readonly<Record<string, string>> = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cataly-deploy-prepare-")));
  directories.push(directory);
  const remote = join(directory, "published");
  const buildHome = join(directory, "build-home");
  mkdirSync(remote);
  mkdirSync(buildHome);
  const put = (path: string, value: string): void => {
    mkdirSync(dirname(join(remote, path)), { recursive: true });
    writeFileSync(join(remote, path), value);
  };
  const tracked: string[] = [];
  for (const relative of ["", "skills/cataly-mode/scripts", "extension"]) {
    const prefix = relative ? `${relative}/` : "";
    put(
      `${prefix}fixture-dep/package.json`,
      '{"name":"fixture-dep","version":"1.0.0","type":"module","exports":"./index.ts"}',
    );
    put(`${prefix}fixture-dep/index.ts`, "export const localDependency = 1;\n");
    put(
      `${prefix}package.json`,
      JSON.stringify({
        name: relative ? "deployment-fixture" : "cataly",
        version: "1.0.0",
        type: "module",
        dependencies: { "fixture-dep": "file:./fixture-dep" },
      }),
    );
    const installed = Bun.spawnSync([process.execPath, "install", "--ignore-scripts", "--silent"], {
      cwd: join(remote, relative),
      env: { HOME: buildHome, PATH: process.env["PATH"] },
      stdout: "ignore",
      stderr: "pipe",
    });
    if (installed.exitCode !== 0) throw new Error(installed.stderr.toString());
    tracked.push(
      `${prefix}package.json`,
      `${prefix}bun.lock`,
      `${prefix}fixture-dep/package.json`,
      `${prefix}fixture-dep/index.ts`,
    );
  }
  put("src/app.ts", "export const release = 'published';\n");
  put("skills/cataly-mode/scripts/src/cli.ts", "#!/usr/bin/env bun\nconsole.log('fixture');\n");
  chmodSync(join(remote, "skills/cataly-mode/scripts/src/cli.ts"), 0o755);
  put("extension/index.ts", "export default function extension() {}\n");
  tracked.push("src/app.ts", "skills/cataly-mode/scripts/src/cli.ts", "extension/index.ts");
  // This checkout's native source bundle; the configured private OMP reports its locked version.
  for (const name of ["native-omp.lock", "native-omp.patch"]) {
    put(name, readFileSync(resolve(import.meta.dir, "..", name), "utf8"));
    tracked.push(name);
  }
  for (const [path, value] of Object.entries(published)) {
    put(path, value);
    tracked.push(path);
  }
  git(remote, "init", "-b", "main");
  git(remote, "config", "user.name", "Cataly deployment fixture");
  git(remote, "config", "user.email", "deployment@example.invalid");
  git(remote, "add", "--", ...tracked);
  git(remote, "commit", "-m", "Published source fixture");
  const candidate = join(directory, "candidate");
  git(directory, "clone", "--no-local", "--", remote, candidate);
  const omp = join(directory, "omp");
  const { nativeVersion } = JSON.parse(readFileSync(join(remote, "native-omp.lock"), "utf8")) as {
    nativeVersion: string;
  };
  writeFileSync(omp, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(nativeVersion)}\n`, { mode: 0o755 });
  const home = join(directory, "operator-home");
  mkdirSync(join(home, ".cataly/state"), { recursive: true });
  writeFileSync(join(home, ".cataly/config.json"), '{"owner":"unchanged"}\n');
  writeFileSync(join(home, ".cataly/state/owner.json"), '{"cursor":17}\n');
  const config = parseDeploymentConfig(
    {
      releaseRoot: "managed",
      liveSource: "operator-home/.cataly/src",
      home,
      catalyHome: join(home, ".cataly"),
      catalyConfig: join(home, ".cataly/config.json"),
      stateDir: join(home, ".cataly/state"),
      bun: process.execPath,
      omp,
      restartLock: "operator-home/.cataly/restart.lock",
      launcherPath: "operator-home/.cataly/bin/managed-restart",
      healthTimeoutMs: 100,
    },
    directory,
  );
  const full = sourceManifest(candidate);
  const input: DeploymentInput = {
    remote,
    candidate,
    commit: git(remote, "rev-parse", "HEAD"),
    tree: git(remote, "rev-parse", "HEAD^{tree}"),
    sourceHash: full.hash,
    publicManifest: sourceManifest(remote),
  };
  const record: DeploymentRecord = {
    version: 1,
    id: "fixture",
    inputHash: "input",
    configHash: "config",
    commit: input.commit,
    tree: input.tree,
    sourceHash: full.hash,
    releasePath: join(config.releaseRoot, "release"),
    directory: join(config.releaseRoot, "transaction"),
    createdAt: new Date().toISOString(),
    status: "prepared",
    step: "prepare",
  };
  return { directory, remote, candidate, home, config, input, record, put };
}
