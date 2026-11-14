import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { withState } from "./fakes.ts";

const inboundCli = async (args: string[], environment: Record<string, string> = {}) => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, runtime: "herdr", hooks: {} }));
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "record-discord-inbound.ts"),
        join(import.meta.dir, "../src/cli.ts"),
        "inbound",
        "discord",
        ...args,
      ],
      {
        env: {
          HOME: state.dir,
          PATH: "/usr/bin:/bin",
          DORI_CONFIG: config,
          DORI_STATE_DIR: state.dir,
          DORI_DISCORD_TOKEN: "synthetic-inbound-token",
          DORI_DISCORD_OWNER_ID: "10",
          DORI_DISCORD_CHANNEL_ID: "20",
          ...environment,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const path = join(state.dir, "discord-inbound", "20.json");
    const cursor = existsSync(path) ? fileDiscordInboundStore(state.dir, "20").load() : undefined;
    expect(`${out}\n${err}`).not.toMatch(/synthetic-inbound-token|private|Authorization/);
    return { out, err, code, cursor };
  } finally {
    state.done();
  }
};

test("public Discord intake defaults to three seconds and honors --loop in minutes", async () => {
  for (const [args, milliseconds] of [
    [[], 3_000],
    [["--loop", "0.1"], 6_000],
  ] as const) {
    const { out, err, code, cursor } = await inboundCli([...args]);
    expect({ code, err, cursor }).toEqual({ code: 0, err: "", cursor: "104" });
    expect(out.split("\n").filter((line) => line.startsWith("INBOUND"))).toEqual([
      "INBOUND_READY discord owner=10 channel=20 bot=99",
      'INBOUND discord 20 101 from=owner ref=- "first owner text"',
      'INBOUND discord 20 103 from=owner ref=101 "owner reply"',
    ]);
    const receipt = out.split("\n").find((line) => line.startsWith("DISCORD_INBOUND_QA "));
    expect(JSON.parse(receipt?.slice("DISCORD_INBOUND_QA ".length) ?? "null")).toEqual({
      delays: [milliseconds, milliseconds],
      polls: 2,
      requests: 5,
    });
  }
});

test("an extra channel list naming the same channel is read once and announced once", async () => {
  const { out, err, code } = await inboundCli(["--loop", "0"], { DORI_DISCORD_CHANNEL_IDS: " 20 ,20" });
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out.trim().split("\n")[0]).toBe("INBOUND_READY discord owner=10 channel=20 bot=99");
});

test("explicit --loop 0 performs one poll and exits with its cursor persisted", async () => {
  const { out, err, code, cursor } = await inboundCli(["--loop", "0"]);
  expect({ code, err, cursor }).toEqual({ code: 0, err: "", cursor: "102" });
  expect(out.trim().split("\n")).toEqual([
    "INBOUND_READY discord owner=10 channel=20 bot=99",
    'INBOUND discord 20 101 from=owner ref=- "first owner text"',
  ]);
});

test("invalid owner, authentication, permission and content-intent setup never announce readiness", async () => {
  for (const environment of [
    { DORI_DISCORD_OWNER_ID: "1e3" },
    { DORI_DISCORD_TOKEN: "invalid-token" },
    { DORI_TEST_DISCORD_CASE: "permissions" },
    { DORI_TEST_DISCORD_CASE: "intent" },
    { DORI_DISCORD_SCOPE: "everything" },
    { DORI_DISCORD_CHANNEL_IDS: "20,abc" },
  ] as const) {
    const { out, err, code, cursor } = await inboundCli(["--loop", "0"], environment);
    expect({ code, out, cursor }).toEqual({ code: 1, out: "", cursor: undefined });
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(err).not.toContain("invalid-token");
  }
});
