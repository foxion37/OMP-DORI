import { afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import type { DeploymentInput, DeploymentRecord } from "../src/update/deployment-types.ts";
import { sourceManifest } from "../src/update/source.ts";
import { git } from "./update-setup.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
export function preparationFixture() {
  const directory = mkdtempSync(join(tmpdir(), "dori-deploy-prepare-"));
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
  for (const relative of ["", "skills/dori-mode/scripts", "extension"]) {
    const prefix = relative ? `${relative}/` : "";
    put(
      `${prefix}fixture-dep/package.json`,
      '{"name":"fixture-dep","version":"1.0.0","type":"module","exports":"./index.ts"}',
    );
    put(`${prefix}fixture-dep/index.ts`, "export const localDependency = 1;\n");
    put(
      `${prefix}package.json`,
      JSON.stringify({
        name: relative ? "deployment-fixture" : "dori-superagent",
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
  put("skills/dori-mode/scripts/src/cli.ts", "#!/usr/bin/env bun\nconsole.log('fixture');\n");
  chmodSync(join(remote, "skills/dori-mode/scripts/src/cli.ts"), 0o755);
  put("extension/index.ts", "export default function extension() {}\n");
  put("omp-ulw.lock", `${"a".repeat(40)}\n`);
  tracked.push("src/app.ts", "skills/dori-mode/scripts/src/cli.ts", "extension/index.ts", "omp-ulw.lock");
  git(remote, "init", "-b", "main");
  git(remote, "config", "user.name", "Dori deployment fixture");
  git(remote, "config", "user.email", "deployment@example.invalid");
  git(remote, "add", "--", ...tracked);
  git(remote, "commit", "-m", "Published source fixture");
  const candidate = join(directory, "candidate");
  git(directory, "clone", "--no-local", "--", remote, candidate);
  mkdirSync(join(candidate, "ref/omp-ulw"), { recursive: true });
  writeFileSync(join(candidate, "ref/omp-ulw/index.ts"), "export const opaquePin = 'preserved';\n");
  const home = join(directory, "operator-home");
  mkdirSync(join(home, ".dori/state"), { recursive: true });
  writeFileSync(join(home, ".dori/config.json"), '{"owner":"unchanged"}\n');
  writeFileSync(join(home, ".dori/state/owner.json"), '{"cursor":17}\n');
  const config = parseDeploymentConfig(
    {
      releaseRoot: "managed",
      liveSource: "operator-home/.dori/src",
      home,
      doriHome: join(home, ".dori"),
      doriConfig: join(home, ".dori/config.json"),
      stateDir: join(home, ".dori/state"),
      bun: process.execPath,
      omp: process.execPath,
      herdr: process.execPath,
      pane: "w1:p1",
      sessionId: "same-session",
      model: "openai-codex/gpt-6.1-sol",
      restartLock: "operator-home/.dori/restart.lock",
      launcherPath: "operator-home/.dori/bin/managed-restart",
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
