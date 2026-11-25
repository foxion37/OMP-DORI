import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as localReader from "../skills/cataly-mode/scripts/src/config.ts";
import { SourceBundleError } from "./release/source-bundle.ts";
import { ConfigError as RuntimeConfigError, readRuntimeChoice } from "./runtime/select.ts";
import { assertSetupFile, type SetupSnapshot } from "./setup-files.ts";

const readerOverrideKeys = ["agentCommand", "stateDir", "leadPane"] as const;
export const setupOverrideKeys = [...readerOverrideKeys, "sessionRuntime"] as const;

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
  for (const key of ["CATALY_AGENT_ARGV", "CATALY_AGENT_CMD", "CATALY_STATE_DIR", "CATALY_LEAD_PANE"])
    delete baselineEnv[key];
  delete baselineEnv["CATALY_RUNTIME"];
  const overridden: string[] = [];
  let reason: string | undefined;
  try {
    const effective = await reader.loadConfig(selected, home, env);
    const baseline = await reader.loadConfig(selected, home, baselineEnv);
    // Runtime selection is handled by the session chooser, not by the config reader's field overrides.
    const sessionRuntime = env["CATALY_RUNTIME"]
      ? readRuntimeChoice({ env, config: effective, configPath: selected }).kind
      : undefined;
    if (selectedFile) {
      for (const key of readerOverrideKeys) {
        if (!isDeepStrictEqual(baseline[key], effective[key])) overridden.push(key);
      }
      if (
        sessionRuntime !== undefined &&
        readRuntimeChoice({ env: baselineEnv, config: baseline, configPath: selected }).kind !== sessionRuntime
      )
        overridden.push("sessionRuntime");
    }
  } catch (error) {
    reason =
      error instanceof reader.ConfigError || error instanceof RuntimeConfigError
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
