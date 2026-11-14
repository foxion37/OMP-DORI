import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeploymentConfig } from "../src/update/deployment.ts";

export function deploymentConfig(root: string) {
  return parseDeploymentConfig(
    {
      releaseRoot: "managed",
      liveSource: "home/.dori/src",
      home: "home",
      doriHome: "home/.dori",
      doriConfig: "home/.dori/config.json",
      stateDir: "home/.dori/state",
      bun: "home/private-bun/bun",
      omp: "home/private-omp/omp",
      herdr: "home/private-cli/herdr",
      herdrSession: "owned-namespace",
      pane: "w1:p1",
      sessionId: "preserved-session",
      model: "openai-codex/gpt-6.1-sol",
      restartLock: "home/.dori/restart.lock",
      launcherPath: "home/.dori/bin/restart",
      healthTimeoutMs: 100,
    },
    root,
  );
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dori-deploy-files-"));
  directories.push(root);
  const config = parseDeploymentConfig(
    {
      releaseRoot: "releases",
      liveSource: "home/.dori/src",
      home: "home",
      doriHome: "home/.dori",
      doriConfig: "home/.dori/config.json",
      stateDir: "home/.dori/state",
      bun: process.execPath,
      omp: process.execPath,
      herdr: process.execPath,
      pane: "w1:p1",
      sessionId: "preserved-session",
      model: "openai-codex/gpt-6.1-sol",
      restartLock: "home/.dori/restart.lock",
      launcherPath: "home/.dori/bin/managed-restart",
      healthTimeoutMs: 100,
      stopTimeoutMs: 100,
    },
    root,
  );
  mkdirSync(config.liveSource, { recursive: true });
  writeFileSync(join(config.liveSource, "owner.ts"), "export const owner = 'original';\n");
  return { root, config };
}
