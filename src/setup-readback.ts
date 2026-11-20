import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as localReader from "../skills/dori-mode/scripts/src/config.ts";
import { SourceBundleError } from "./release/source-bundle.ts";
import { assertSetupFile, type SetupSnapshot } from "./setup-files.ts";

export const setupOverrideKeys = ["agentCommand", "stateDir", "ompUlwPath", "leadPane"] as const;

/** Observe configuration with the caller's bound reader; never start native OMP or probe an account. */
export async function setupReadback(
  snapshot: SetupSnapshot,
  scope: string,
  selection: {
    readonly path?: string;
    readonly home?: string;
    readonly reader?: Pick<typeof localReader, "configPath" | "loadConfig" | "ConfigError">;
  } = {},
) {
  assertSetupFile(snapshot);
  const reader = selection.reader ?? localReader;
  const home = selection.home ?? homedir();
  const selected = resolve(selection.path ?? reader.configPath());
  const selectedFile =
    selected === snapshot.path ||
    ((await Bun.file(selected).exists()) && realpathSync(selected) === realpathSync(snapshot.path));
  const env = { ...process.env };
  const baselineEnv = { ...env };
  for (const key of ["DORI_AGENT_ARGV", "DORI_AGENT_CMD", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "DORI_LEAD_PANE"])
    delete baselineEnv[key];
  const overridden: string[] = [];
  let reason: string | undefined;
  try {
    const effective = await reader.loadConfig(selected, home, env);
    const baseline = await reader.loadConfig(selected, home, baselineEnv);
    if (selectedFile) {
      for (const key of setupOverrideKeys) {
        if (!isDeepStrictEqual(baseline[key], effective[key])) overridden.push(key);
      }
    }
  } catch (error) {
    reason =
      error instanceof reader.ConfigError
        ? "invalid-effective-configuration"
        : error instanceof SourceBundleError
          ? "current-updater-runtime-unavailable"
          : "configuration-reader-unavailable";
  }
  assertSetupFile(snapshot);
  return {
    path: snapshot.path,
    sha256: snapshot.sha256,
    saved: true,
    scope,
    selectedConfig: selected,
    effective: reason ? "unavailable" : selectedFile && overridden.length === 0 ? "selected" : "shadowed",
    overridden: reason ? null : overridden,
    ...(reason ? { reason } : {}),
  };
}
