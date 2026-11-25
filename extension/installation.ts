import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { configPath } from "../skills/cataly-mode/scripts/src/config.ts";
import { consumerReleaseHome } from "../src/release/runtime.ts";

/** Global discovery runs before OMP supplies the resumed branch. Select config without changing the host environment. */
export function extensionInstallation(source = resolve(import.meta.dir, "..")) {
  const env = { ...process.env };
  if (env["CATALY_HOME"] === undefined) {
    const physical = realpathSync(source);
    env["CATALY_HOME"] = consumerReleaseHome(physical);
  }
  const home = env["CATALY_HOME"];
  const ordinaryConfig = configPath();
  const configFile = env["CATALY_CONFIG"] ?? (home === undefined ? ordinaryConfig : join(home, "config.json"));
  const ordinaryPaneRoot =
    configFile === ordinaryConfig &&
    env["CATALY_HOME"] === process.env["CATALY_HOME"] &&
    env["CATALY_STATE_DIR"] === process.env["CATALY_STATE_DIR"];
  env["CATALY_CONFIG"] = configFile;
  return { configFile, installationHome: home, env, ordinaryPaneRoot };
}
