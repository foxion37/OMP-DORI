import { expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneLaunchEnv } from "../src/slack-token.ts";
import { refusedOnWindows, withState } from "./fakes.ts";

for (const ambientInLauncher of [false, true]) {
  test(`lane overrides terminal-server messenger tokens even when launcher has them: ${ambientInLauncher}`, async () => {
    const state = withState();
    try {
      const file = join(state.dir, "slack-token");
      writeFileSync(file, "fixture-slack-file\n");
      chmodSync(file, 0o600);
      const ambient = {
        HOME: state.dir,
        PI_CODING_AGENT_DIR: join(state.dir, "native-auth"),
        OPENAI_API_KEY: "fixture-provider-auth",
        CATALY_DISCORD_TOKEN: "fixture-discord",
        CATALY_TELEGRAM_TOKEN: "fixture-telegram",
        CATALY_SLACK_TOKEN: "fixture-wrong-slack",
      };
      const env = laneLaunchEnv(ambientInLauncher ? ambient : { HOME: state.dir }, join(state.dir, "config.json"));
      expect(Object.values(env).some((value) => value.startsWith("fixture-"))).toBe(false);
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { slackToken } from ${JSON.stringify(new URL("../src/slack-token.ts", import.meta.url).href)};
           console.log(JSON.stringify({
             discord: process.env.CATALY_DISCORD_TOKEN, telegram: process.env.CATALY_TELEGRAM_TOKEN,
             provider: process.env.OPENAI_API_KEY, agent: process.env.PI_CODING_AGENT_DIR,
             home: process.env.HOME, slack: slackToken(),
           }));`,
        ],
        { env: { ...ambient, ...env }, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(err).toBe("");
      expect(JSON.parse(out)).toEqual({
        discord: "",
        telegram: "",
        provider: ambient.OPENAI_API_KEY,
        agent: ambient.PI_CODING_AGENT_DIR,
        home: state.dir,
        slack: "fixture-slack-file",
      });
      expect(readFileSync(file, "utf8")).toBe("fixture-slack-file\n");
    } finally {
      state.done();
    }
  });
}

for (const [platform, args] of [
  ["telegram", ["send", "telegram", "--to", "1", "--text", "fixture"]],
  ["telegram", ["inbound", "telegram", "--loop", "0"]],
  ["discord", ["presence", "discord"]],
  ["discord", ["send", "discord", "--thread", "1", "--text", "fixture"]],
] as const) {
  test(`empty lane token stops ${args.slice(0, 2).join(" ")} before any network request`, () => {
    const state = withState();
    try {
      const preload = join(state.dir, "network-guard.ts");
      writeFileSync(
        preload,
        `const attempted = () => { console.error("NETWORK_ATTEMPTED"); process.exit(93); };
         globalThis.fetch = attempted;
         globalThis.WebSocket = class { constructor() { attempted(); } };`,
      );
      const child = Bun.spawnSync(
        [process.execPath, "--preload", preload, join(import.meta.dir, "../src/cli.ts"), ...args],
        {
          env: {
            HOME: state.dir,
            PATH: "/usr/bin:/bin",
            CATALY_CONFIG: join(state.dir, "config.json"),
            CATALY_DISCORD_TOKEN: "",
            CATALY_TELEGRAM_TOKEN: "",
            CATALY_TELEGRAM_OWNER_ID: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5_000,
        },
      );
      expect(child.exitCode).toBe(1);
      expect(child.stdout.toString()).toBe("");
      expect(child.stderr.toString().trim()).toBe(
        refusedOnWindows(args, `CATALY_${platform.toUpperCase()}_TOKEN is not set`),
      );
    } finally {
      state.done();
    }
  });
}
