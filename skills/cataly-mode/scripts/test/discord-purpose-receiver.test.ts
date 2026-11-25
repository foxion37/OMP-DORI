import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { discordAskReceivers } from "../src/messenger/discord-ask-receiver.ts";
import { discordInboundOptions } from "../src/messenger/discord-inbound-env.ts";
import { discordLoopback, LOOPBACK_TOKEN, nativeDiscordBinary } from "./discord-loopback.ts";
import { withState } from "./fakes.ts";

const inboundEnv = {
  CATALY_DISCORD_OWNER_ID: "10",
  CATALY_DISCORD_CHANNEL_ID: " 20, 30,20 ",
  CATALY_DISCORD_CHANNEL_IDS: "30, 20, 30",
};

test("shared inbound settings deduplicate legacy and plural channel IDs in their original order", () => {
  expect(discordInboundOptions(inboundEnv)).toEqual({
    ownerId: "10",
    channelIds: ["20", "30"],
    all: false,
    threads: true,
  });
});

// Drives the real native receiver against a loopback REST stand-in; the receiver route is its published scope, found
// only when its process identity matches discord-ask-receiver.ts's for the same PID on Linux and macOS.
test.skipIf(process.platform === "win32" || !nativeDiscordBinary())(
  "shared inbound settings preserve the receiver channel set across duplicate singular and plural IDs",
  async () => {
    const state = withState();
    const discord = discordLoopback([]);
    writeFileSync(join(state.dir, "config.json"), JSON.stringify({ stateDir: state.dir, hooks: {} }));
    const cli = join(import.meta.dir, "../src/cli.ts");
    const child = Bun.spawn([process.execPath, cli, "inbound", "discord", "--loop", "0.05"], {
      env: {
        HOME: state.dir,
        PATH: "/usr/bin:/bin",
        CATALY_CONFIG: join(state.dir, "config.json"),
        CATALY_STATE_DIR: state.dir,
        CATALY_DISCORD_NATIVE_BIN: nativeDiscordBinary()!,
        CATALY_DISCORD_API_BASE: discord.base,
        CATALY_DISCORD_TOKEN: LOOPBACK_TOKEN,
        ...inboundEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const expected = [{ owner: "10", explicit: ["20", "30"], watched: ["20", "30"] }];
      for (let i = 0; i < 500 && discordAskReceivers(state.dir, LOOPBACK_TOKEN, discord.base).length === 0; i++)
        await Bun.sleep(10);
      expect(discordAskReceivers(state.dir, LOOPBACK_TOKEN, discord.base)).toEqual(expected);
    } finally {
      child.kill();
      await child.exited;
      discord.stop();
      state.done();
    }
    const ready = "INBOUND_READY discord owner=10 channel=20,30 bot=99";
    expect(await new Response(child.stdout).text()).toStartWith(ready);
  },
  10_000,
);
