/** Hands `cataly inbound discord` to the Rust monitor in place: same PID, same stdout, the IPC socket as fd 0. */
import { dlopen, FFIType } from "bun:ffi";
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { guardConsumerReservation } from "../../../../src/release/launch-leases.ts";
import { configPath } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { messengerProfileDefaultsEnabled } from "./messenger/profile-defaults.ts";
import { laneLaunchEnv } from "./slack-token.ts";

type DiscordMonitor = {
  readonly supervised: boolean;
  readonly channels: readonly string[];
  readonly threads: boolean;
  readonly all: boolean;
  readonly gateway: boolean;
  readonly pollMinutes: number;
  readonly context: boolean;
  readonly wake: boolean;
  readonly activityFile?: string;
};

const repo = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

/** The `cataly [--cwd W] [--model M] discord --cataly-state S ...` argv for one monitor. */
function discordMonitorArgv(
  executable: string,
  config: FlowDeps["config"],
  monitor: DiscordMonitor,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const argv = [executable];
  const workspace = env["CATALY_DISCORD_NATIVE_WORKSPACE"] || config.laneWorkspace;
  if (workspace) {
    if (!isAbsolute(workspace)) throw new Error("CATALY_DISCORD_NATIVE_WORKSPACE and laneWorkspace must be absolute");
    argv.push("--cwd", workspace);
  }
  const model = env["CATALY_DISCORD_NATIVE_MODEL"]?.trim();
  if (model) argv.push("--model", model);
  argv.push("discord", "--cataly-state", resolve(config.stateDir));
  if (monitor.supervised) argv.push("--supervised");
  for (const channel of new Set(monitor.channels)) argv.push("--channel", channel);
  if (monitor.all) argv.push("--scope-all");
  else if (monitor.threads) argv.push("--follow-threads");
  if (monitor.context) argv.push("--context");
  if (monitor.wake) argv.push("--wake-lanes");
  if (monitor.activityFile !== undefined) {
    if (!isAbsolute(monitor.activityFile)) throw new Error("--activity-file must be an absolute path");
    argv.push("--activity-file", monitor.activityFile);
  }
  if (monitor.gateway) argv.push("--gateway");
  else {
    const seconds = Math.ceil(monitor.pollMinutes * 60);
    if (seconds > 3600) throw new Error("--loop must be at most 60 minutes for Discord intake");
    argv.push("--poll-seconds", String(seconds));
  }
  if (config.recall?.enabled) argv.push("--recall-retention-days", String(config.recall.retentionDays ?? 30));
  if (messengerProfileDefaultsEnabled())
    argv.push("--default-avatar", repo("skills/cataly-mode/assets/cataly-avatar.jpg"));
  return argv;
}

/** Everything a woken lane needs that only the TS config knows; Rust refuses `--wake-lanes` without it. The detached
 * headless host is the Rust binary itself (`headless-host`), so the record names no host program. */
function discordLaneLaunch(config: FlowDeps["config"], env: Readonly<Record<string, string | undefined>>) {
  return JSON.stringify({
    agentCommand: config.agentCommand,
    sessionsDir: resolve(config.sessionsDir),
    guard: config.guard,
    env: laneLaunchEnv(env, env["CATALY_CONFIG"] ?? configPath(), config),
    wakeConfig: fileURLToPath(new URL("./discord-lane-wake.yml", import.meta.url)),
  });
}

/**
 * Move Bun's IPC channel (fd 3) to fd 0 for a supervised monitor, then close the original so no OMP that Rust
 * spawns inherits it. An unsupervised receiver keeps no channel at all.
 */
function handOverIpc(supervised: boolean): void {
  const library =
    process.platform === "linux" ? "libc.so.6" : process.platform === "darwin" ? "libSystem.B.dylib" : undefined;
  if (!library) throw new Error("Native Discord intake requires Linux or macOS");
  const libc = dlopen(library, {
    dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  try {
    if (supervised && libc.symbols.dup2(3, 0) === -1) throw new Error("Could not move the monitor IPC channel to fd 0");
    if (libc.symbols.close(3) === -1) throw new Error("Could not close the original monitor IPC channel");
  } finally {
    libc.close();
  }
}

/** Never returns: the Rust monitor replaces this process. */
export function execDiscordMonitor(executable: string, deps: FlowDeps, monitor: DiscordMonitor): never {
  const { NODE_CHANNEL_FD: _fd, NODE_CHANNEL_SERIALIZATION_MODE: _mode, ...env } = process.env;
  const argv = discordMonitorArgv(executable, deps.config, monitor, env);
  if (typeof process.execve !== "function") throw new Error("This Bun cannot hand Discord intake to the native binary");
  mkdirSync(deps.config.stateDir, { recursive: true, mode: 0o700 });
  if (monitor.wake) {
    env["CATALY_DISCORD_LANE_LAUNCH"] = discordLaneLaunch(deps.config, env);
    guardConsumerReservation(repo(""), deps.config.stateDir)();
  }
  if (process.connected) handOverIpc(monitor.supervised);
  return process.execve(executable, argv, env);
}
