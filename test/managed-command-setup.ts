import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { actorEnv } from "../src/update/deployment-process.ts";
import type { ToolchainReceipt } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";
import { deploymentConfig } from "./update-deploy-setup.ts";

const previous = new Map<string, string | undefined>();
afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
});
export function environment(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!previous.has(key)) previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export const executable = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    '#!/bin/sh\nif [ "$1" = --version ]; then printf "18.20.0\\n"; exit; fi\nprintf \'%s\\0\' "$0" "$@"\n',
    { mode: 0o755 },
  );
};

export function managedCommand() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-managed-command-")));
  const omp = join(root, "selected space 'quote' $(touch substitution-ran); touch suffix-ran; #", "bin/omp");
  executable(omp);
  const config = { ...deploymentConfig(root), bun: process.execPath, omp };
  mkdirSync(config.doriHome, { recursive: true, mode: 0o700 });
  const nativeConfig = join(root, "native-config.json");
  writeFileSync(nativeConfig, "{}");
  const toolchain: ToolchainReceipt = {
    omp,
    bun: process.execPath,
    nativeVersion: "18.20.0",
    ompEntry: omp,
    ompEntryHash: digest(readFileSync(omp)),
    bunHash: digest(readFileSync(process.execPath)),
    nativeConfig,
    nativeConfigHash: digest(readFileSync(nativeConfig)),
    ompUlw: {
      source: join(root, "prepared source 'extension'; literal"),
      identity: "a".repeat(64),
      directory: join(root, "selected ulw 'quote'"),
    },
    nativeOverride: true,
  };
  const env = actorEnv(config, toolchain);
  environment({ ...env, DORI_AGENT_CMD: undefined });
  const argv = [omp, "--config", nativeConfig, "--no-extensions", "-e", join(toolchain.ompUlw!.source, "extension")];
  return { root, omp, config, toolchain, env, argv };
}

export const argvOutput = (stdout: Buffer): string[] => stdout.toString().split("\0").slice(0, -1);

export const shell = (command: string, root: string, env: Record<string, string>) =>
  Bun.spawnSync(["/bin/sh", "-c", command], { cwd: root, env });
