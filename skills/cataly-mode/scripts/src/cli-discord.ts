/** `cataly inbound discord`: validates the shared settings, then hands intake to the Rust monitor. */
import { die } from "./cli-context.ts";
import { discordNativeBinary } from "../../../../src/native-binary.ts";
import { execDiscordMonitor } from "./cli-discord-exec.ts";
import { runNativeDiscord } from "./cli-discord-native.ts";
import type { FlowDeps } from "./done-flow.ts";
import { discordInboundOptions } from "./messenger/discord-inbound-env.ts";
import { headUnresolved } from "./messenger/head-admission-state.ts";

const NATIVE_REQUIRED =
  "Discord intake requires the native Cataly binary. Build it with `cargo build --locked --release` and set " +
  "CATALY_DISCORD_NATIVE_BIN to the absolute path of target/release/cataly, or reinstall Cataly on a host with a " +
  "Rust toolchain so it installs $CATALY_HOME/bin/cataly-native.";

export const discordInboundCommand = async (
  deps: FlowDeps,
  options: {
    readonly gateway: boolean;
    readonly pollMinutes: number;
    readonly context: boolean;
    readonly wake: boolean;
    readonly activityFile?: string;
  },
) => {
  const { gateway, pollMinutes, context, wake, activityFile } = options;
  const { stateDir } = deps.config;
  if (wake && (gateway || pollMinutes <= 0)) die("--wake-lanes requires continuous Discord REST intake");
  const env = process.env;
  const { channelIds, all, threads } = discordInboundOptions(env);
  const executable = discordNativeBinary() ?? die(NATIVE_REQUIRED);
  const head = env["CATALY_DISCORD_HEAD_CHANNEL_ID"]?.trim();
  const admission = env["CATALY_MONITOR_ADMISSION"];
  const supervised = admission !== undefined;
  // The monitor contract is one live IPC channel; anything else cannot settle a head admission.
  if (supervised && (admission !== "1" || !process.connected)) throw headUnresolved();
  const standalone = !context && !wake && activityFile === undefined;
  if (head && (supervised || process.connected || all || !standalone))
    die("Rust-owned Discord head requires an independent receiver with explicit scope");
  const workspace = env["CATALY_DISCORD_NATIVE_WORKSPACE"] || deps.config.laneWorkspace;
  if (!supervised && !process.connected && !all && (head || (standalone && workspace))) {
    return await runNativeDiscord(executable, {
      ...options,
      stateDir,
      channels: channelIds,
      threads,
      head,
      workspace: deps.config.laneWorkspace,
    });
  }
  try {
    execDiscordMonitor(executable, deps, {
      supervised,
      channels: channelIds,
      threads,
      all,
      gateway,
      pollMinutes,
      context,
      wake,
      ...(activityFile === undefined ? {} : { activityFile }),
    });
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
};
