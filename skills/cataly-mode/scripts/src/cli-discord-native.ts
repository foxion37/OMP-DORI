import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discordInboundEnv } from "./messenger/discord-inbound-state.ts";
import { messengerProfileDefaultsEnabled } from "./messenger/profile-defaults.ts";

type Config = {
  readonly stateDir: string;
  readonly channels: readonly string[];
  readonly workspace?: string;
  readonly pollMinutes: number;
  readonly gateway: boolean;
  readonly threads: boolean;
  readonly head?: string | undefined;
};

/** A Rust-owned OMP receiver (standalone lanes or the head): Rust owns sockets, cursors, approval and replies. */
export async function runNativeDiscord(executable: string, config: Config): Promise<void> {
  const workspace = process.env["CATALY_DISCORD_NATIVE_WORKSPACE"] || config.workspace;
  if (!isAbsolute(executable) || !workspace || !isAbsolute(workspace)) {
    throw new Error("Set absolute CATALY_DISCORD_NATIVE_BIN and CATALY_DISCORD_NATIVE_WORKSPACE paths");
  }
  const selected = process.env["CATALY_DISCORD_NATIVE_CHANNEL_ID"];
  const channels = selected
    ? [discordInboundEnv("CATALY_DISCORD_NATIVE_CHANNEL_ID", selected)]
    : [...new Set(config.channels)];
  if (channels.length === 0 || channels.some((channel) => !config.channels.includes(channel))) {
    throw new Error("Native Discord requires explicitly configured inbound channel IDs");
  }
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const argv = [executable, "--cwd", workspace];
  const model = process.env["CATALY_DISCORD_NATIVE_MODEL"]?.trim();
  if (model) argv.push("--model", model);
  const inbox = join(config.stateDir, "discord-inbound");
  if (config.head) {
    const head = discordInboundEnv("CATALY_DISCORD_HEAD_CHANNEL_ID", config.head);
    if (!channels.includes(head)) throw new Error("Rust-owned Discord head must be explicitly configured");
    argv.push(
      "discord",
      "--state-dir",
      join(config.stateDir, "discord-head"),
      "--head-channel",
      head,
      "--ask-state",
      resolve(config.stateDir),
    );
  } else {
    argv.push(
      "discord",
      "--state-dir",
      join(config.stateDir, "discord-native"),
      "--ask-state",
      resolve(config.stateDir),
    );
  }
  argv.push("--inbox", inbox, "--import-cursors", inbox);
  for (const channel of channels) argv.push("--channel", channel);
  if (config.threads) argv.push("--follow-threads");
  if (config.gateway) argv.push("--gateway");
  else argv.push("--poll-seconds", String(Math.ceil(config.pollMinutes * 60)));
  if (messengerProfileDefaultsEnabled()) {
    argv.push("--default-avatar", fileURLToPath(new URL("../../assets/cataly-avatar.jpg", import.meta.url)));
  }
  await runNativeDiscordChild(argv);
}

export async function runNativeDiscordChild(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("disconnect", stop);
  try {
    const code = await child.exited;
    if (code !== 0) throw new Error(`Native Discord command exited with status ${code}`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("disconnect", stop);
  }
}
