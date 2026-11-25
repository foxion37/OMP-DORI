import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withState } from "./fakes.ts";

// POSIX-only: the exec handoff needs dup2/close and execve.
const posix = test.skipIf(process.platform === "win32");
const cli = join(import.meta.dir, "../src/cli.ts");
const avatar = resolve(import.meta.dir, "../../assets/cataly-avatar.jpg");

/** Prints its PID, argv, IPC facts on fd 0/3 and the lane-launch handoff, then answers on the IPC socket. */
const fakeNative = (dir: string) => {
  const binary = join(dir, "native-monitor");
  writeFileSync(
    binary,
    [
      "#!/bin/sh",
      'echo "PID $$"',
      'for arg in "$@"; do printf "ARG %s\\n" "$arg"; done',
      'if [ -S /dev/stdin ]; then echo "FD0_SOCKET yes"; else echo "FD0_SOCKET no"; fi',
      'if [ -e /dev/fd/3 ]; then echo "FD3 open"; else echo "FD3 closed"; fi',
      'echo "CHANNEL_ENV ${NODE_CHANNEL_FD:--}"',
      'echo "LAUNCH ${CATALY_DISCORD_LANE_LAUNCH:--}"',
      'if [ -S /dev/stdin ]; then printf \'{"event":"native"}\\n\' >&0; fi',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return binary;
};

const monitor = async (
  args: string[],
  environment: Record<string, string> = {},
  options: { readonly supervised?: boolean; readonly recall?: object } = {},
) => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        stateDir: join(state.dir, "state"),
        laneWorkspace: state.dir,
        hooks: {},
        ...(options.recall ? { recall: options.recall } : {}),
      }),
    );
    const ipc: unknown[] = [];
    const child = Bun.spawn([process.execPath, cli, "inbound", "discord", ...args], {
      env: {
        HOME: state.dir,
        PATH: "/usr/bin:/bin",
        CATALY_CONFIG: config,
        CATALY_DISCORD_NATIVE_BIN: fakeNative(state.dir),
        CATALY_DISCORD_OWNER_ID: "10",
        CATALY_DISCORD_CHANNEL_ID: "20",
        CATALY_MESSENGER_PROFILE_DEFAULTS: "off",
        ...(options.supervised ? { CATALY_MONITOR_ADMISSION: "1" } : {}),
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      ...(options.supervised ? { serialization: "json" as const, ipc: (message: unknown) => ipc.push(message) } : {}),
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // The answer was written before exit; give the parent's IPC reader its turn.
    for (let i = 0; options.supervised && code === 0 && ipc.length === 0 && i < 100; i++) await Bun.sleep(10);
    const lines = out.trim().split("\n");
    const argv = lines.filter((line) => line.startsWith("ARG ")).map((line) => line.slice(4));
    const fact = (name: string) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
    return { code, err, out, argv, ipc, pid: child.pid, fact, stateDir: join(state.dir, "state"), dir: state.dir };
  } finally {
    state.done();
  }
};

posix("a supervised monitor becomes the Rust process with the IPC socket as fd 0 and fd 3 closed", async () => {
  const result = await monitor(["--context"], { CATALY_DISCORD_CHANNEL_IDS: "21, 20" }, { supervised: true });
  expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
  expect(Number(result.fact("PID"))).toBe(result.pid);
  expect(result.fact("FD0_SOCKET")).toBe("yes");
  expect(result.fact("FD3")).toBe("closed");
  expect(result.fact("CHANNEL_ENV")).toBe("-");
  expect(result.ipc).toEqual([{ event: "native" }]);
  expect(result.argv).toEqual([
    "--cwd",
    result.dir,
    "discord",
    "--cataly-state",
    result.stateDir,
    "--supervised",
    "--channel",
    "20",
    "--channel",
    "21",
    "--follow-threads",
    "--context",
    "--poll-seconds",
    "3",
  ]);
});

posix("each monitor option maps to exactly one native flag", async () => {
  const once = ["--follow-threads", "--poll-seconds", "0"];
  const cases: [string[], Record<string, string>, object | undefined, string[]][] = [
    [["--gateway"], { CATALY_DISCORD_THREADS: "off" }, undefined, ["--gateway"]],
    [["--loop", "0.5"], { CATALY_DISCORD_SCOPE: "all" }, undefined, ["--scope-all", "--poll-seconds", "30"]],
    [["--loop", "0"], {}, { enabled: true }, [...once, "--recall-retention-days", "30"]],
    [["--loop", "0"], {}, { enabled: true, retentionDays: 7 }, [...once, "--recall-retention-days", "7"]],
    [["--loop", "0"], {}, { enabled: false }, once],
  ];
  for (const [args, environment, recall, tail] of cases) {
    const result = await monitor(args, environment, { supervised: true, ...(recall ? { recall } : {}) });
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
    expect(result.argv.slice(6)).toEqual(["--channel", "20", ...tail]);
  }
  const model = await monitor(["--loop", "0"], { CATALY_DISCORD_NATIVE_MODEL: "fixture/model" }, { supervised: true });
  expect(model.argv.slice(0, 4)).toEqual(["--cwd", model.dir, "--model", "fixture/model"]);
  const profile = await monitor(["--loop", "0"], { CATALY_MESSENGER_PROFILE_DEFAULTS: "on" }, { supervised: true });
  expect(profile.argv.slice(-2)).toEqual(["--default-avatar", avatar]);
});

posix("--wake-lanes and --activity-file hand the lane launch and activity path to the native monitor", async () => {
  const state = withState();
  try {
    const activity = join(state.dir, "activity.json");
    const args = ["--loop", "0.05", "--wake-lanes", "--activity-file", activity];
    const result = await monitor(args, {}, { supervised: true });
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
    expect(result.argv.slice(6)).toEqual([
      "--channel",
      "20",
      "--follow-threads",
      "--wake-lanes",
      "--activity-file",
      activity,
      "--poll-seconds",
      "3",
    ]);
    const launch = JSON.parse(result.fact("LAUNCH") ?? "null");
    expect(Object.keys(launch).sort()).toEqual(["agentCommand", "env", "guard", "sessionsDir", "wakeConfig"]);
    expect(launch.agentCommand.at(-1)).toBe("{prompt}");
    expect(launch.wakeConfig).toBe(resolve(import.meta.dir, "../src/discord-lane-wake.yml"));
    expect(launch.guard).toMatchObject({ panesMax: expect.any(Number) });
    expect(launch.env["CATALY_CONFIG"]).toEndWith("config.json");
    const plain = await monitor(["--loop", "0"], {}, { supervised: true });
    expect(plain.fact("LAUNCH")).toBe("-");
  } finally {
    state.done();
  }
});

posix("an unsupervised receiver execs the native monitor in place without an IPC flag", async () => {
  const result = await monitor(["--loop", "0"], { CATALY_DISCORD_SCOPE: "all" });
  expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
  expect(Number(result.fact("PID"))).toBe(result.pid);
  expect(result.fact("FD0_SOCKET")).toBe("no");
  expect(result.argv).not.toContain("--supervised");
  expect(result.argv.slice(2)).toEqual([
    "discord",
    "--cataly-state",
    result.stateDir,
    "--channel",
    "20",
    "--scope-all",
    "--poll-seconds",
    "0",
  ]);
});

posix("Rust-owned OMP receivers keep their own native state and the TypeScript cursor import", async () => {
  for (const threads of [undefined, "off"] as const) {
    const result = await monitor(["--gateway"], threads === undefined ? {} : { CATALY_DISCORD_THREADS: threads });
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
    expect(result.argv).toContain("--state-dir");
    expect(result.argv[result.argv.indexOf("--state-dir") + 1]).toBe(join(result.stateDir, "discord-native"));
    expect(result.argv.includes("--follow-threads")).toBe(threads === undefined);
    expect(result.argv).not.toContain("--cataly-state");
  }
  const head = await monitor(["--gateway"], { CATALY_DISCORD_HEAD_CHANNEL_ID: "20" });
  expect({ code: head.code, err: head.err }).toEqual({ code: 0, err: "" });
  const inbox = join(head.stateDir, "discord-inbound");
  expect(head.argv).toEqual(expect.arrayContaining(["--head-channel", "20", "--inbox", inbox, "--import-cursors"]));
  const outside = await monitor(["--gateway"], { CATALY_DISCORD_HEAD_CHANNEL_ID: "99" });
  expect(outside).toMatchObject({ code: 1, err: expect.stringContaining("explicitly configured") });
});

posix("Discord intake refuses to start without the native binary or with invalid settings", async () => {
  const missing = await monitor(["--loop", "0"], { CATALY_DISCORD_NATIVE_BIN: "off" }, { supervised: true });
  expect({ code: missing.code, out: missing.out }).toEqual({ code: 1, out: "" });
  expect(missing.err).toContain("requires the native Cataly binary");
  expect(missing.err).toContain("cargo build --locked --release");
  for (const environment of [
    { CATALY_DISCORD_OWNER_ID: "1e3" },
    { CATALY_DISCORD_SCOPE: "everything" },
    { CATALY_DISCORD_CHANNEL_IDS: "20,abc" },
    { CATALY_DISCORD_THREADS: "sometimes" },
  ]) {
    const { code, out, err } = await monitor(["--loop", "0"], environment, { supervised: true });
    expect({ code, out }).toEqual({ code: 1, out: "" });
    expect(err.trim().split("\n")).toHaveLength(1);
  }
  const rest = await monitor(["--gateway", "--wake-lanes"], {}, { supervised: true });
  expect({ code: rest.code, out: rest.out }).toEqual({ code: 1, out: "" });
  expect(rest.err).toContain("--wake-lanes requires continuous Discord REST intake");
  const foreign = await monitor(["--loop", "0"], { CATALY_MONITOR_ADMISSION: "2" }, { supervised: true });
  expect({ code: foreign.code, out: foreign.out }).toEqual({ code: 1, out: "" });
  expect(foreign.err).toContain("HEAD_ADMISSION_UNRESOLVED");
});
