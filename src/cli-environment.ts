import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { consumerReleaseHome } from "./release/runtime.ts";

export function bindCliEnvironment(): void {
  // The primary entry points are symlinks, not shell wrappers. Follow the loaded release, never cwd.
  const installedHome = consumerReleaseHome(realpathSync(resolve(import.meta.dir, "..")));
  if (installedHome !== undefined) process.env["CATALY_HOME"] ??= installedHome;
  const home = process.env["CATALY_HOME"];
  if (home !== undefined) process.env["CATALY_CONFIG"] ??= join(home, "config.json");
}
