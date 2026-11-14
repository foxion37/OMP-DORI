import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

const gatewayCli = async (scenario: string) => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, runtime: "herdr", hooks: {} }));
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "record-gateway.ts"),
        join(import.meta.dir, "../src/cli.ts"),
        "presence",
        "discord",
      ],
      {
        env: {
          HOME: state.dir,
          PATH: "/usr/bin:/bin",
          DORI_CONFIG: config,
          DORI_STATE_DIR: state.dir,
          DORI_DISCORD_TOKEN: "synthetic-gateway-token",
          GATEWAY_CASE: scenario,
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
    expect(`${out}\n${err}`).not.toContain("synthetic-gateway-token");
    return { out, err, code };
  } finally {
    state.done();
  }
};

test("Discord CLI reports genuine READY and RESUMED, heartbeat ACKs, and cleans up on SIGINT", async () => {
  const { out, err, code } = await gatewayCli("lifecycle");
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out.split("\n").filter((line) => line.startsWith("PRESENCE_"))).toEqual([
    "PRESENCE_READY discord event=READY",
    "PRESENCE_ACK discord seq=3",
    "PRESENCE_RECONNECT discord reason=server_reconnect code=0 retry_in=0s",
    "PRESENCE_READY discord event=RESUMED",
    "PRESENCE_ACK discord seq=4",
    "PRESENCE_STOPPED discord",
  ]);
  const receipt = out.split("\n").find((line) => line.startsWith("GATEWAY_QA "));
  expect(JSON.parse(receipt?.slice("GATEWAY_QA ".length) ?? "null")).toEqual({
    opened: 2,
    active: 0,
    timers: 0,
    identified: 1,
    resumed: 1,
    presenceUpdates: 1,
    heartbeats: 2,
  });
});

test("Discord CLI SIGTERM during backoff cancels reconnect without opening another socket", async () => {
  const { out, err, code } = await gatewayCli("stop-backoff");
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out.split("\n").filter((line) => line.startsWith("PRESENCE_"))).toEqual([
    "PRESENCE_READY discord event=READY",
    "PRESENCE_RECONNECT discord reason=closed code=1006 retry_in=5s",
    "PRESENCE_STOPPED discord",
  ]);
  const receipt = out.split("\n").find((line) => line.startsWith("GATEWAY_QA "));
  expect(JSON.parse(receipt?.slice("GATEWAY_QA ".length) ?? "null")).toEqual({
    opened: 1,
    active: 0,
    timers: 0,
    identified: 1,
    resumed: 0,
    presenceUpdates: 0,
    heartbeats: 0,
  });
});

test("a terminal Gateway rejection exits nonzero with one sanitized error and no false readiness", async () => {
  const { out, err, code } = await gatewayCli("terminal");
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err.trim().split("\n")).toHaveLength(1);
  expect(err).toContain("Discord gateway closed code=4014 (disallowed intents)");
  expect(err).not.toMatch(/"op"|Error:| at /);
});
