import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decisionCommands } from "../src/cli-decisions.ts";
import { journalCommands } from "../src/cli-journal.ts";
import { laneCommands } from "../src/cli-lanes.ts";
import { messengerCommands } from "../src/cli-messenger.ts";
import { opsCommands } from "../src/cli-ops.ts";
import { prCommands } from "../src/cli-pr.ts";
import { statusCommands } from "../src/cli-status.ts";
import { voiceCommand } from "../src/cli-voice.ts";
import { type TestState, withState } from "./fakes.ts";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const groups = {
  "cli-journal.ts": journalCommands,
  "cli-lanes.ts": laneCommands,
  "cli-ops.ts": opsCommands,
  "cli-messenger.ts": messengerCommands,
  "cli-decisions.ts": decisionCommands,
  "cli-pr.ts": prCommands,
  "cli-status.ts": statusCommands,
  "cli-voice.ts": { voice: voiceCommand },
};
const blocked = [...Object.keys(groups), "/src/update/cli.ts", "/src/release/cli.ts", "cli-harness.ts"];
let state: TestState;
beforeEach(() => {
  state = withState();
  mkdirSync(join(state.dir, "state/lanes/fixture"), { recursive: true });
  writeFileSync(
    join(state.dir, "config.json"),
    JSON.stringify({ runtime: "herdr", stateDir: join(state.dir, "state"), ompUlwPath: "" }),
  );
  writeFileSync(
    join(state.dir, "state/lanes/fixture.json"),
    JSON.stringify({
      key: "fixture",
      title: "offline",
      brief: "brief",
      done: "file proof",
      thread: "none",
      cwd: state.dir,
      openedAt: "2026-01-01T00:00:00Z",
      status: "working",
    }),
  );
});
afterEach(() => state.done());

function invoke(args: string[], forbidden: string[] = []) {
  const preload = join(state.dir, "load-guard.ts");
  // The subprocess intentionally tests import boundaries; throw on actual loading, never replace a handler.
  writeFileSync(
    preload,
    `
import { plugin } from "bun";
import { readFileSync } from "node:fs";
plugin({ name: "cli-load-guard", setup(build) {
  build.onLoad({ filter: /[.]ts$/ }, ({ path }) => {
    // The suffixes are written with '/'; Windows hands the loader '\\'.
    const suffix = ${JSON.stringify(forbidden)}.find(suffix => path.replace(/\\\\/g, "/").endsWith(suffix));
    if (suffix) throw new Error("BLOCKED_IMPORT:" + suffix);
    return { contents: readFileSync(path, "utf8"), loader: "ts" };
  });
} });
`,
  );
  const result = Bun.spawnSync([process.execPath, "--preload", preload, cli, ...args], {
    cwd: state.dir,
    env: {
      HOME: state.dir,
      PATH: process.env["PATH"],
      DORI_CONFIG: join(state.dir, "config.json"),
      DORI_RUNTIME: "herdr",
      DORI_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
    },
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("version loads no command or configuration graph, even with invalid config", () => {
  writeFileSync(join(state.dir, "config.json"), "invalid config");
  const result = invoke(
    ["--version"],
    [...blocked, "/scripts/src/config.ts", "cli-context.ts", "registry.ts", "run.ts"],
  );
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out.trim()).toMatch(/^[0-9]+[.][0-9]+[.][0-9]+/);
});

test("successful journal commands do not import lane, messenger, ops or updater graphs", () => {
  // Journal auto-tracking already depends on the accepted PR graph.
  const forbidden = blocked.filter((name) => name !== "cli-journal.ts" && name !== "cli-pr.ts");
  expect(invoke(["checkpoints", "fixture"], forbidden)).toEqual({ code: 0, out: "[]\n", err: "" });
  const report = invoke(["report", "fixture", "--kind", "milestone", "--text", "offline"], forbidden);
  expect(report.code).toBe(0);
  expect(report.err).toBe("");
  expect(report.out).toContain("[REPORT] fixture | milestone | offline");
});

for (const [group, commands] of Object.entries(groups)) {
  test.each(Object.keys(commands))(`every ${group} command routes to its own graph: %s`, (command) => {
    const result = invoke([command], blocked);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain(`BLOCKED_IMPORT:${group}`);
    expect(result.out).not.toContain("dori <command>");
  });
}

test.each([
  ["harness", "cli-harness.ts"],
  ["update", "/src/release/cli.ts"],
  ["upstream", "/src/update/cli.ts"],
])("%s dispatches before ordinary config validation and propagates its import failure", (command, selected) => {
  writeFileSync(join(state.dir, "config.json"), "invalid config");
  const result = invoke([command], blocked);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain(`BLOCKED_IMPORT:${selected}`);
});

test.each(["", "not-a-command", "__proto__", "constructor", "--help"])(
  "usage preserves exit code for %s without loading handlers",
  (command) => {
    const result = invoke(command ? [command] : [], blocked);
    expect(result.code).toBe(command ? 1 : 0);
    expect(result.err).toBe("");
    expect(result.out).toContain("dori <command>");
    expect(result.out).toContain("verified releases: check, install, status, rollback, cache");
  },
);

test("ordinary commands still validate config before choosing their handler graph", () => {
  writeFileSync(join(state.dir, "config.json"), JSON.stringify({ runtime: "invalid" }));
  const result = invoke(["checkpoints", "fixture"], blocked);
  expect(result.code).toBe(1);
  expect(result.err).toContain("runtime");
  expect(result.err).not.toContain("BLOCKED_IMPORT");
});

test("a real journal error retains one-line formatting after lazy imports", () => {
  const path = join(state.dir, "state/lanes/fixture/checkpoints.jsonl");
  writeFileSync(path, "not json\n");
  const result = invoke(["checkpoints", "fixture"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain(`${path}:1:`);
  expect(result.err.trim().split("\n")).toHaveLength(1);
});

test("accepted decision flags reach the lazy handler with repeated options intact", () => {
  const result = invoke([
    "decision",
    "ask",
    "choose one",
    "--source",
    "fixture",
    "--lane",
    "fixture",
    "--option",
    "first",
    "--option",
    "second",
    "--recommend",
    "2",
  ]);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(JSON.parse(result.out)).toMatchObject({
    question: "choose one",
    source: "fixture",
    lane: "fixture",
    options: ["first", "second"],
    recommend: 2,
  });
});

test("an accepted decision error retains its original class and one-line formatting", () => {
  const result = invoke(["decision", "answer", "missing", "yes", "--source", "fixture"]);
  expect(result.code).toBe(1);
  expect(result.out).toBe("");
  expect(result.err).toContain("decision not found: missing");
  expect(result.err.trim().split("\n")).toHaveLength(1);
});

test("accepted PR listing still handles its own cursor error after lazy loading", () => {
  const path = join(state.dir, "state/pr-watch-state.json");
  writeFileSync(path, "not json\n");
  const result = invoke(["pr", "list"]);
  expect(result.code).toBe(0);
  expect(result.out).toBe("[]\n");
  expect(result.err).toContain(`PR_WATCH_WARNING ${path}:`);
  expect(result.err.trim().split("\n")).toHaveLength(1);
});
