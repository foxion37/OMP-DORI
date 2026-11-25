import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, monitorCleanup } from "../src/boot-monitors.ts";
import { CATALY_COMMANDS, CATALY_VALUE_OPTIONS } from "../src/monitor-cataly.ts";
import { laneWords } from "../src/monitor-command.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";

// Which words of a watch's own command may name a lane: base matched every word; each command's program, and a cataly
// program's command and platform, are excluded (src/monitor-command.ts).
// test/boot-monitor-matrix.test.ts holds every reviewed counterexample.
const lane = (key: string, status: LaneStatus): Lane => ({
  key,
  status,
  sessionRef: { runtime: "tern", id: `w1:${key}` },
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: "2026-01-01T12:00:00.000Z",
});

type Spec = { readonly name?: string; readonly cwd?: string; readonly argv: readonly string[] };
const manifest = (specs: readonly Spec[]): Manifest => ({
  path: "/fixture/monitors/owner.json",
  data: {
    version: 1,
    sessionId: "owner",
    monitors: specs.map((spec, index) => ({
      name: spec.name ?? `watch-${index}`,
      argv: spec.argv,
      cwd: spec.cwd ?? "/repo",
    })),
  },
});
// A shell command line is read by the same parser as an argv (monitor-command.ts).
const commandLanes = (command: string, cwd = "/repo") => laneWords(command, cwd);

test("a closed lane named in an argument position is still claimed, even when its key is a cataly program name", () => {
  const lanes = ["cataly", "omp-cataly", "api-fix", "harness-lane"].map((key) => lane(key, "closed"));
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["cataly", "checkpoints", "cataly"], name: "CATALY" },
      { argv: ["cataly", "checkpoints", "omp-cataly"], name: "OMP" },
      { argv: ["rg", "-n", "/src/omp-cataly", "api-fix"], name: "PATH" },
      { argv: ["bun", "/repo/src/cli.ts", "send", "harness-lane", "hi"], name: "HARNESS" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["CATALY", ["cataly:argv:key"]],
    ["OMP", ["omp-cataly:argv:key"]],
    ["PATH", ["api-fix:argv:key"]],
    ["HARNESS", ["harness-lane:argv:key"]],
  ]);
  expect(commandLanes("cataly checkpoints cataly")).toContain("cataly");
});

test("a shared cataly watch behind a launcher with options is still not claimed by its own command words", () => {
  const keys: unknown[] = ["cataly", "inbound", "slack"];
  const lanes = keys.map((key) => lane(String(key), "closed"));
  const argv = [
    ["env", "-u", "NODE_OPTIONS", "cataly", "inbound", "slack"],
    ["env", "-i", "/home/user/.cataly/bin/cataly", "inbound", "slack"],
    ["timeout", "60", "cataly", "inbound", "slack"],
    ["timeout", "--signal", "TERM", "60", "cataly", "inbound", "slack"],
    ["nice", "-n", "10", "cataly", "inbound", "slack"],
    ["stdbuf", "-oL", "cataly", "inbound", "slack"],
    ["FOO=a b", "cataly", "inbound", "slack"],
  ];
  const commands = [
    'FOO="a b" cataly inbound slack',
    "env -u NODE_OPTIONS cataly inbound slack",
    "bash -lc 'exec -a intake cataly inbound slack'",
    'sh -c "nohup cataly inbound slack"',
  ];
  expect(monitorCleanup(lanes, [manifest(argv.map((words) => ({ argv: words })))])).toEqual([]);
  for (const command of commands) expect(commandLanes(command).filter((word) => keys.includes(word))).toEqual([]);
});

test("a relative cli.ts entry is cataly's own, and an argument after its command still names a lane", () => {
  const lanes = ["freshness", "api-fix"].map((key) => lane(key, "closed"));
  const skill = "/w/skills/cataly-mode/scripts";
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["bun", "src/cli.ts", "freshness"], cwd: skill, name: "SKILL" },
      { argv: ["bun", "src/cli.ts", "send", "api-fix", "hi"], cwd: "/w", name: "HARNESS" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([["HARNESS", ["api-fix:argv:key"]]]);
  expect(commandLanes("bun run src/cli.ts freshness", skill)).not.toContain("freshness");
});

test("a word after a cataly program that is no cataly command still names a lane: rg -c cataly api-fix", () => {
  const result = monitorCleanup([lane("api-fix", "closed")], [manifest([{ argv: ["rg", "-c", "cataly", "api-fix"] }])]);
  expect(result.map((m) => m.match)).toEqual([["api-fix:argv:key"]]);
  expect(commandLanes("rg -c cataly api-fix")).toContain("api-fix");
});

test("a shared cataly watch inside a loop, a condition, a subshell, a cd or an env -C stays unclaimed", () => {
  const scripts = "/w/skills/cataly-mode/scripts";
  const lanes = ["slack", "freshness"].map((key) => lane(key, "closed"));
  const monitors: Spec[] = [
    { argv: ["env", "-C", scripts, "bun", "src/cli.ts", "freshness"], cwd: "/repo" },
    { argv: ["bun", "src/cli.ts", "freshness"], cwd: scripts },
    { argv: ["timeout", "-vk", "5", "60", "cataly", "inbound", "slack"] },
  ];
  expect(monitorCleanup(lanes, [manifest(monitors)])).toEqual([]);
  for (const command of [
    "while true; do cataly inbound slack --loop 1; sleep 3; done",
    "while true; do exec cataly inbound slack --loop 1; done",
    "if test -f /ready; then cataly inbound slack --loop 1; fi",
    "( cataly inbound slack --loop 1 )",
    "bash -O extglob -c 'exec cataly inbound slack --loop 1'",
  ])
    expect(commandLanes(command)).not.toContain("slack");
  expect(commandLanes(`cd ${scripts} && bun src/cli.ts freshness`)).not.toContain("freshness");
  // An open lane named anywhere still keeps the watch.
  const open = [lane("slack", "working"), lane("api", "closed")];
  const shell = ["sh", "-c", "while true; do cataly inbound slack; done # api"];
  expect(monitorCleanup(open, [manifest([{ argv: shell }])])).toEqual([]);
});

test("relayed is a command word, while its target still identifies a closed lane", () => {
  const lanes = ["relayed", "api"].map((key) => lane(key, "closed"));
  const receipt = "a".repeat(64);
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["cataly", "relayed", "api", "--report", receipt], name: "ARGV" },
      { argv: ["cataly", "relayed", "relayed", "--report", receipt], name: "TARGET" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["ARGV", ["api:argv:key"]],
    ["TARGET", ["relayed:argv:key"]],
  ]);
  expect(commandLanes(`cataly relayed api --report ${receipt}`)).toContain("api");
});

test.each(["owner", "report"])("report option values do not hide a messenger platform: %s", (option) => {
  const monitors: Spec[] = [{ argv: ["cataly", "inbound", `--${option}`, "slack", "discord"] }];
  expect(monitorCleanup([lane("discord", "closed")], [manifest(monitors)])).toEqual([]);
  expect(commandLanes(`cataly inbound --${option} slack discord`)).not.toContain("discord");
});

test("lanes is a command word, but report can still target a lane named lanes", () => {
  const result = monitorCleanup(
    [lane("lanes", "closed")],
    [
      manifest([
        { argv: ["cataly", "lanes", "--thread", "discord:123", "--open"], name: "ARGV" },
        { argv: ["cataly", "report", "lanes", "--kind", "done", "--text", "complete"], name: "TARGET" },
      ]),
    ],
  );
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([["TARGET", ["lanes:argv:key"]]]);
  expect(commandLanes("cataly lanes --open")).not.toContain("lanes");
});

test("a Discord voice monitor does not belong to lanes named voice or discord", () => {
  const lanes = ["voice", "discord"].map((key) => lane(key, "closed"));
  expect(monitorCleanup(lanes, [manifest([{ argv: ["cataly", "voice", "discord"] }])])).toEqual([]);
  expect(commandLanes("cataly voice discord").filter((word) => word === "voice" || word === "discord")).toEqual([]);
});

test("the monitor vocabulary matches CLI dispatch and value options", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
  const commands = [
    ...cli.matchAll(/^\s*case "([\w-]+)":/gm),
    ...cli.matchAll(/^if \(command === "([\w-]+)"\)/gm),
  ].flatMap(([, word]) => (word && !word.startsWith("-") ? [word] : []));
  const flags = readFileSync(join(import.meta.dir, "../src/cli-flags.ts"), "utf8");
  const values = [...flags.matchAll(/^\s+"?([\w-]+)"?: \{ type: "string"/gm)].map(([, word]) => word ?? "");
  expect(Object.keys(CATALY_COMMANDS).sort()).toEqual([...new Set(commands)].sort());
  expect(Object.keys(CATALY_VALUE_OPTIONS).sort()).toEqual(values.sort());
});
