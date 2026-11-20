import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { withState } from "./fakes.ts";

// POSIX-only: the Discord queue and cursor stores require private uid-owned directories.
const posix = test.skipIf(process.platform === "win32");

const inboundCli = async (
  args: string[],
  environment: Record<string, string> = {},
  prepare: (stateDir: string) => void = () => {},
) => {
  const state = withState();
  try {
    prepare(state.dir);
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

posix("public Discord intake defaults to three seconds and honors --loop in minutes", async () => {
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
      'INBOUND_REPLY discord 20 103 {"id":"101","author":null,"text":null,"status":"unresolved"}',
    ]);
    const receipt = out.split("\n").find((line) => line.startsWith("DISCORD_INBOUND_QA "));
    expect(JSON.parse(receipt?.slice("DISCORD_INBOUND_QA ".length) ?? "null")).toEqual({
      delays: [milliseconds, milliseconds],
      polls: 2,
      requests: 8, // Existing quiet probes plus the default-on configured-channel metadata read.
    });
  }
});

posix("a REST poll exits nonzero on a Retry-After above the automatic wait budget", async () => {
  const { out, err, code, cursor } = await inboundCli([], { DORI_TEST_DISCORD_CASE: "long-rate-limit" });
  expect({ code, cursor }).toEqual({ code: 1, cursor: "100" });
  expect(err).toContain("HTTP 429; Retry-After exceeds the 60s automatic retry limit");
  expect(out.trim()).toBe("INBOUND_READY discord owner=10 channel=20 bot=99");
});

posix("an extra channel list naming the same channel is read once and announced once", async () => {
  const { out, err, code } = await inboundCli(["--loop", "0"], { DORI_DISCORD_CHANNEL_IDS: " 20 ,20" });
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out.trim().split("\n")[0]).toBe("INBOUND_READY discord owner=10 channel=20 bot=99");
});

posix("explicit --loop 0 performs one poll and exits with its cursor persisted", async () => {
  const { out, err, code, cursor } = await inboundCli(["--loop", "0"]);
  expect({ code, err, cursor }).toEqual({ code: 0, err: "", cursor: "102" });
  expect(out.trim().split("\n")).toEqual([
    "INBOUND_READY discord owner=10 channel=20 bot=99",
    'INBOUND discord 20 101 from=owner ref=- "first owner text"',
  ]);
});

posix("invalid owner, authentication, permission and content-intent setup never announce readiness", async () => {
  for (const environment of [
    { DORI_DISCORD_OWNER_ID: "1e3" },
    { DORI_DISCORD_TOKEN: "invalid-token" },
    { DORI_TEST_DISCORD_CASE: "permissions" },
    { DORI_TEST_DISCORD_CASE: "intent" },
    { DORI_DISCORD_SCOPE: "everything" },
    { DORI_DISCORD_CHANNEL_IDS: "20,abc" },
    { DORI_DISCORD_THREADS: "sometimes" },
  ] as const) {
    const { out, err, code, cursor } = await inboundCli(["--loop", "0"], environment);
    expect({ code, out, cursor }).toEqual({ code: 1, out: "", cursor: undefined });
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(err).not.toContain("invalid-token");
  }
});

posix("--context ends each group with where it was posted and the purposes recorded there", async () => {
  const purposes = (dir: string) =>
    writeFileSync(
      join(dir, "discord-channels.json"),
      JSON.stringify({
        "30": { purpose: "omp-dori development", name: "dev", updatedAt: "2026-11-17T00:00:00.000Z" },
        "20": { purpose: "one task", updatedAt: "2026-11-17T00:00:00.000Z" },
      }),
    );
  const message = 'INBOUND discord 20 101 from=owner ref=- "first owner text"';
  const where = await inboundCli(["--loop", "0", "--context"], { DORI_TEST_DISCORD_CASE: "context" }, purposes);
  expect({ code: where.code, err: where.err, cursor: where.cursor }).toEqual({ code: 0, err: "", cursor: "102" });
  expect(where.out.trim().split("\n").slice(1)).toEqual([
    message,
    `INBOUND_CONTEXT discord 20 101 ${JSON.stringify({
      channel: { id: "30", name: "dev", topic: "editable topic", purpose: "omp-dori development" },
      thread: { id: "20", name: "task thread", purpose: "one task" },
    })}`,
  ]);
  // A failed lookup still delivers the message and commits it; the record says what is known, without the body.
  const denied = await inboundCli(["--loop", "0", "--context"], { DORI_TEST_DISCORD_CASE: "context-denied" }, purposes);
  expect({ code: denied.code, cursor: denied.cursor }).toEqual({ code: 0, cursor: "102" });
  expect(denied.out.trim().split("\n").slice(1)).toEqual([
    message,
    `INBOUND_CONTEXT discord 20 101 ${JSON.stringify({
      channel: { id: "20", purpose: "one task" },
      thread: null,
      error: "channel lookup failed (HTTP 403)",
    })}`,
  ]);
  // Without --context nothing is looked up and the output is unchanged, even where lookups would fail.
  const plain = await inboundCli(["--loop", "0"], { DORI_TEST_DISCORD_CASE: "context-denied" }, purposes);
  expect(plain.out.trim().split("\n").slice(1)).toEqual([message]);
});

for (const threads of [undefined, "on", "off"] as const) {
  posix(`public thread setting ${threads ?? "unset"} retains owner output and explicit cursor`, async () => {
    const result = await inboundCli(["--loop", "0"], threads === undefined ? {} : { DORI_DISCORD_THREADS: threads });
    expect({ code: result.code, err: result.err, cursor: result.cursor }).toEqual({
      code: 0,
      err: "",
      cursor: "102",
    });
    expect(result.out.trim().split("\n")).toEqual([
      "INBOUND_READY discord owner=10 channel=20 bot=99",
      'INBOUND discord 20 101 from=owner ref=- "first owner text"',
    ]);
  });
}
