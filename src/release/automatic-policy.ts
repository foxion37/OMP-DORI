import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { processExists } from "../update/proc.ts";
import { type ConsumerPaths, readJson, realDirectory, regularFile } from "./files.ts";
import { preflightInstallation } from "./install.ts";
import { waitLaunchGate } from "./launch-leases.ts";
import { assertNativeSource } from "./native.ts";
import type { InstalledState } from "./state.ts";
import { assertInstalledPointer, verifyRelease } from "./state.ts";

export function automaticConfig(paths: ConsumerPaths): Record<string, unknown> {
  const config = readJson(paths.config);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid consumer config");
  return config as Record<string, unknown>;
}

/** External native choices are deliberate compatibility contracts, not automatic-update targets. */
export function automaticOverrides(paths: ConsumerPaths, config: Record<string, unknown>): boolean {
  if (["CATALY_OMP", "CATALY_AGENT_ARGV"].some((name) => process.env[name] !== undefined)) return true;
  const configuredFile = process.env["CATALY_CONFIG"];
  if (configuredFile !== undefined && resolve(configuredFile) !== paths.config) return true;
  const commandOverride = process.env["CATALY_AGENT_CMD"];
  if (commandOverride !== undefined && commandOverride !== "omp" && commandOverride !== join(paths.cataly, "bin/omp"))
    return true;
  const command = config["agentCommand"];
  return (
    command !== undefined &&
    (!Array.isArray(command) ||
      (command[0] !== "omp" &&
        command[0] !== join(paths.cataly, "bin/omp") &&
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
  assertNativeSource(source, paths.home);
  return source;
}

/** Automatic activation is more conservative than manual updates: any live lane also holds it. */
export function preflightAutomaticInstallation(paths: ConsumerPaths): void {
  preflightInstallation(paths);
  const config = automaticConfig(paths);
  const states = new Set([join(paths.cataly, "state")]);
  for (const configured of [config["stateDir"], process.env["CATALY_STATE_DIR"]]) {
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
