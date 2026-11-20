import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decisionCommands } from "../src/cli-decisions.ts";
import { journalCommands } from "../src/cli-journal.ts";
import { laneCommands } from "../src/cli-lanes.ts";
import { messengerCommands } from "../src/cli-messenger.ts";
import { opsCommands } from "../src/cli-ops.ts";
import { prCommands } from "../src/cli-pr.ts";
import { statusCommands } from "../src/cli-status.ts";
import { voiceCommand } from "../src/cli-voice.ts";
import { DORI_COMMANDS, DORI_VALUE_OPTIONS } from "../src/monitor-dori.ts";
import type { Lane } from "../src/registry.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("the dori command vocabulary is every command the CLI dispatches", () => {
  const tables = [
    ["cli-journal.ts", journalCommands],
    ["cli-lanes.ts", laneCommands],
    ["cli-ops.ts", opsCommands],
    ["cli-messenger.ts", messengerCommands],
    ["cli-decisions.ts", decisionCommands],
    ["cli-pr.ts", prCommands],
    ["cli-status.ts", statusCommands],
    ["cli-voice.ts", { voice: voiceCommand }],
  ] as const;
  // Every word the CLI dispatches, and the module the command lives in: cli.ts's own three come before its tables.
  const groupOf = new Map<string, string>([
    ["harness", "cli-harness.ts"],
    ["update", "/src/release/cli.ts"],
    ["upstream", "/src/update/cli.ts"],
  ]);
  for (const [module, table] of tables) for (const name of Object.keys(table)) groupOf.set(name, module);
  expect(Object.keys(DORI_COMMANDS).sort()).toEqual([...groupOf.keys()].sort());

  const config = join(state.dir, "config.json");
  const lanes = join(state.dir, "state", "lanes");
  mkdirSync(lanes, { recursive: true });
  writeFileSync(config, JSON.stringify({ runtime: "herdr", stateDir: join(state.dir, "state"), ompUlwPath: "" }));
  const lane = {
    key: "zzz",
    status: "working",
    pane: "w1:p1",
    title: "Vocabulary fixture",
    thread: "none",
    brief: "/b.md",
    done: "file /done.md",
    openedAt: "2026-01-01T12:00:00.000Z",
  } satisfies Lane;
  writeFileSync(join(lanes, "zzz.json"), JSON.stringify(lane));
  // The real CLI; the preload fails the load of a blocked module, so a dispatched command stops at its own command
  // module before doing anything and a word no table holds only reaches the usage.
  const invoke = (args: readonly string[], blocked: readonly string[] = []) => {
    const preload = join(state.dir, "load-guard.ts");
    writeFileSync(
      preload,
      `import { plugin } from "bun";
import { readFileSync } from "node:fs";
const blocked = ${JSON.stringify(blocked)};
plugin({ name: "dispatch-guard", setup(build) {
  build.onLoad({ filter: /[.]ts$/ }, ({ path }) => {
    const hit = blocked.find((suffix) => path.split("\\\\").join("/").endsWith(suffix));
    if (hit) throw new Error("BLOCKED_IMPORT:" + hit);
    return { contents: readFileSync(path, "utf8"), loader: "ts" };
  });
} });
`,
    );
    const run = Bun.spawnSync(
      [process.execPath, "--preload", preload, join(import.meta.dir, "../src/cli.ts"), ...args],
      {
        cwd: state.dir,
        env: {
          HOME: state.dir,
          PATH: process.env["PATH"] ?? "",
          DORI_CONFIG: config,
          DORI_RUNTIME: "herdr",
          DORI_TELEMETRY: "0",
          DO_NOT_TRACK: "1",
        },
        timeout: 20_000,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
  };
  const missed = [...groupOf].filter(([word, module]) => {
    const run = invoke([word], [module]);
    return run.code === 0 || !run.err.includes(`BLOCKED_IMPORT:${module}`) || run.out.includes("dori <command>");
  });
  expect(missed).toEqual([]);
  // A word no table holds reaches no command module: the CLI prints its usage instead.
  const stray = invoke(["not-a-command"], [...new Set(groupOf.values())]);
  expect({ dispatched: stray.err.includes("BLOCKED_IMPORT"), usage: stray.out.includes("dori <command>") }).toEqual({
    dispatched: false,
    usage: true,
  });
  // A value option consumes the word after it, so the registered lane "zzz" becomes its value and the command finds no
  // lane key: the bare and the followed run both fail. A flag leaves "zzz" the key and reads its journal instead.
  const broken = Object.keys(DORI_VALUE_OPTIONS).filter(
    (option) =>
      invoke(["checkpoints", `--${option}`, "zzz"]).code === 0 || invoke(["checkpoints", `--${option}`]).code === 0,
  );
  expect(broken).toEqual([]);
  // cli.ts exposes no option list, so its parseArgs declaration text is the only source of truth here: every option
  // declared to take a value must be listed, and no flag may be listed as one.
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
  const declared = [...cli.matchAll(/^\s+"?([\w-]+)"?: \{ type: "string"/gm)].map((match) => match[1] ?? "");
  expect(declared.sort()).toEqual(Object.keys(DORI_VALUE_OPTIONS).sort());
  expect(invoke(["checkpoints", "--dry-run", "zzz"])).toMatchObject({ code: 0, out: "[]\n" });
}, 120_000);
