import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { processExists } from "../update/proc.ts";
import { type ConsumerPaths, readJson, realDirectory, regularFile } from "./files.ts";
import { preflightInstallation } from "./install.ts";
import { waitLaunchGate } from "./launch-leases.ts";
import { assertNativeSource } from "./native.ts";
import { provisionDependency } from "./provision.ts";
import { readSourceBundle } from "./source-bundle.ts";
import type { InstalledState } from "./state.ts";
import { assertInstalledPointer, verifyRelease } from "./state.ts";

export function automaticConfig(paths: ConsumerPaths): Record<string, unknown> {
  const config = readJson(paths.config);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid consumer config");
  return config as Record<string, unknown>;
}

/** External native/ULW choices are deliberate compatibility contracts, not automatic-update targets. */
export function automaticOverrides(paths: ConsumerPaths, config: Record<string, unknown>): boolean {
  if (
    ["OMP_ULW_SRC", "OMP_ULW_REF", "OMP_ULW_REPO", "DORI_OMP", "DORI_AGENT_ARGV", "DORI_OMP_ULW_PATH"].some(
      (name) => process.env[name] !== undefined,
    )
  )
    return true;
  const configuredFile = process.env["DORI_CONFIG"];
  if (configuredFile !== undefined && resolve(configuredFile) !== paths.config) return true;
  const commandOverride = process.env["DORI_AGENT_CMD"];
  if (commandOverride !== undefined && commandOverride !== "omp" && commandOverride !== join(paths.dori, "bin/omp"))
    return true;
  const ulw = config["ompUlwPath"];
  const path = typeof ulw === "string" && ulw.startsWith("~/") ? join(paths.home, ulw.slice(2)) : ulw;
  if (
    path !== undefined &&
    (typeof path !== "string" ||
      !/^omp-ulw-[a-f0-9]{40}(?:-[a-f0-9]{64})?(?:\/index\.ts)?$/.test(relative(paths.dependencies, path)))
  )
    return true;
  const command = config["agentCommand"];
  return (
    command !== undefined &&
    (!Array.isArray(command) ||
      (command[0] !== "omp" &&
        command[0] !== join(paths.dori, "bin/omp") &&
        !(
          typeof command[0] === "string" &&
          /^[a-f0-9]{40}-[a-f0-9]{16}\/scripts\/consumer\/omp$/.test(relative(paths.releases, command[0]))
        )))
  );
}

/** Check existing source and toolchains before optional networking: updating must never hide local drift. */
export async function verifyAutomaticInstallation(paths: ConsumerPaths, state: InstalledState): Promise<string> {
  const gate = await waitLaunchGate(paths);
  try {
    assertInstalledPointer(paths, state);
  } finally {
    gate();
  }
  const source = verifyRelease(paths, state.current);
  if (state.previous) verifyRelease(paths, state.previous);
  if (state.current.requirements.omp === "18.20.0") assertNativeSource(source, paths.home);
  const suffix = state.current.requirements.omp === "18.20.0" ? `-${readSourceBundle(source).identity}` : "";
  const dependency = join(paths.dependencies, `omp-ulw-${state.current.ompUlw.commit}${suffix}`);
  realDirectory(dependency);
  if (!regularFile(join(dependency, "index.ts")))
    throw new Error("Installed public dependency is missing; automatic replacement is held");
  await provisionDependency(paths, state.current, source);
  return source;
}

/** Automatic activation is more conservative than manual updates: any live lane also holds it. */
export function preflightAutomaticInstallation(paths: ConsumerPaths): void {
  preflightInstallation(paths);
  const config = automaticConfig(paths);
  const states = new Set([join(paths.dori, "state")]);
  for (const configured of [config["stateDir"], process.env["DORI_STATE_DIR"]]) {
    if (configured === undefined) continue;
    if (typeof configured !== "string" || !configured) throw new Error("Invalid consumer state directory");
    states.add(resolve(configured.startsWith("~/") ? join(paths.home, configured.slice(2)) : configured));
  }
  for (const state of states) {
    const directory = join(state, "sessions");
    realDirectory(directory);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
      const path = join(directory, name);
      if (!regularFile(path)) continue;
      const record = readJson(path) as { pid?: number; role?: string };
      if (!record || !Number.isSafeInteger(record.pid) || record.pid! <= 0)
        throw new Error("Uncertain session receipt holds automatic activation");
      if (processExists(record.pid!)) throw new Error(`Live session PID ${record.pid} holds automatic activation`);
    }
  }
}
