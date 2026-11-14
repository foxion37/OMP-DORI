#!/usr/bin/env bun
import type { Subprocess } from "bun";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!key || !["--config", "--controller", "--bun"].includes(key) || !value || options.has(key)) {
    console.error("Usage: update-supervisor.ts --config FILE --controller DIRECTORY --bun EXECUTABLE");
    process.exit(2);
  }
  options.set(key, value);
}
const config = options.get("--config");
const controller = options.get("--controller");
const bun = options.get("--bun");
if (!config || !controller || !bun) process.exit(2);
const configPath = resolve(config);
const controllerPath = resolve(controller);
const executable = resolve(bun);
let intervalSeconds: number;
let originalController: string;
try {
  const data: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof data !== "object" || data === null || !("intervalSeconds" in data)) throw new Error();
  const interval = data.intervalSeconds;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > 86400)
    throw new Error();
  intervalSeconds = interval;
  originalController = realpathSync(controllerPath);
} catch {
  console.error("DORI_SUPERVISOR_CONFIG_ERROR");
  process.exit(2);
}
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (
    /^DORI_.*(?:TOKEN|PASSWORD)$/.test(key) ||
    ["SUDO_UID", "SUDO_GID", "SUDO_USER", "GH_TOKEN", "GITHUB_TOKEN"].includes(key)
  )
    delete env[key];
}
env["DORI_TELEMETRY"] = "0";
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
console.log("DORI_SUPERVISOR_READY");
while (!stopped) {
  try {
    child = Bun.spawn(
      [
        executable,
        resolve(controllerPath, "skills/dori-mode/scripts/src/cli.ts"),
        "upstream",
        "check",
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
    if (code === 4) console.error("DORI_SUPERVISOR_RETRY detector=unavailable");
    if (code !== 0 && code !== 3 && code !== 4) {
      console.error(`DORI_SUPERVISOR_HELD exit=${code}`);
      process.exit(2);
    }
    // The service manager reloads this script after a verified controller-link handoff.
    if (realpathSync(controllerPath) !== originalController) process.exit(75);
  } catch {
    console.error("DORI_SUPERVISOR_HELD operation=controller");
    process.exit(2);
  }
  const until = performance.now() + intervalSeconds * 1000;
  while (!stopped && !awakened && performance.now() < until) {
    await Bun.sleep(Math.min(1000, until - performance.now()));
  }
  awakened = false;
}
