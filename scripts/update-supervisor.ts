#!/usr/bin/env bun
import type { Subprocess } from "bun";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadUpdateConfig } from "../src/update/load.ts";
import { loadSourceUpdateConfig } from "../src/update/source-update-config.ts";

const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!key || !["--config", "--controller", "--bun", "--mode"].includes(key) || !value || options.has(key)) {
    console.error(
      "Usage: update-supervisor.ts --config FILE --controller DIRECTORY --bun EXECUTABLE [--mode upstream|source]",
    );
    process.exit(2);
  }
  options.set(key, value);
}
const config = options.get("--config");
const controller = options.get("--controller");
const bun = options.get("--bun");
const mode = options.get("--mode") ?? "upstream";
if (!config || !controller || !bun || !["upstream", "source"].includes(mode)) process.exit(2);
const configPath = resolve(config);
const controllerPath = resolve(controller);
const executable = resolve(bun);
let intervalSeconds: number;
let originalController: string;
try {
  // Use the command's loader so the accepted cadence and defaults cannot drift.
  if (mode === "source") {
    const source = loadSourceUpdateConfig(configPath);
    if (controllerPath !== source.deployment.liveSource)
      throw new Error("source controller must follow deployment.liveSource");
    intervalSeconds = source.intervalSeconds;
  } else intervalSeconds = loadUpdateConfig(configPath).intervalSeconds;
  originalController = realpathSync(controllerPath);
} catch {
  console.error("CATALY_SUPERVISOR_CONFIG_ERROR");
  process.exit(2);
}
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (
    /^CATALY_.*(?:TOKEN|PASSWORD)$/.test(key) ||
    ["SUDO_UID", "SUDO_GID", "SUDO_USER", "GH_TOKEN", "GITHUB_TOKEN"].includes(key)
  )
    delete env[key];
}
env["CATALY_TELEMETRY"] = "0";
env["DO_NOT_TRACK"] = "1";
let stopped = false;
let awakened = false;
process.on("SIGUSR1", () => {
  awakened = true;
});
let child: Subprocess<"ignore", "inherit", "inherit"> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped = true;
    child?.kill(signal);
  });
}
console.log("CATALY_SUPERVISOR_READY");
while (!stopped) {
  let delaySeconds = intervalSeconds;
  try {
    child = Bun.spawn(
      [
        executable,
        resolve(controllerPath, "skills/cataly-mode/scripts/src/cli.ts"),
        ...(mode === "source" ? ["update", "source", "apply", "--when", "idle"] : ["upstream", "check"]),
        "--config",
        configPath,
      ],
      {
        cwd: controllerPath,
        env,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const code = await child.exited;
    child = undefined;
    if (stopped || code === 130) break;
    if (code === 4)
      console.error(
        mode === "source" ? "CATALY_SUPERVISOR_RETRY source=held" : "CATALY_SUPERVISOR_RETRY detector=unavailable",
      );
    if (code === 5) console.error("CATALY_SUPERVISOR_RETRY lock=live-controller");
    if (mode === "source" && code === 6) {
      console.error("CATALY_SUPERVISOR_RETRY source=recovery-pending");
      delaySeconds = Math.min(intervalSeconds, 60);
    }
    if (code !== 0 && code !== 3 && code !== 4 && code !== 5 && !(mode === "source" && code === 6)) {
      console.error(`CATALY_SUPERVISOR_HELD exit=${code}`);
      process.exit(2);
    }
    // The service manager reloads this script after a verified controller-link handoff.
    if (realpathSync(controllerPath) !== originalController) process.exit(75);
  } catch {
    console.error("CATALY_SUPERVISOR_HELD operation=controller");
    process.exit(2);
  }
  const until = performance.now() + delaySeconds * 1000;
  while (!stopped && !awakened && performance.now() < until) {
    await Bun.sleep(Math.min(1000, until - performance.now()));
  }
  awakened = false;
}
