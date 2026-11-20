import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, type Monitor, monitorCleanup, readMonitorManifests } from "../src/boot-monitors.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { withState } from "./fakes.ts";

// Which words of a watch's own command may name a lane: base matched every word; each command's program, and a dori
// program's command and platform, are excluded (src/monitor-command.ts), and a legacy record never crashes the match.
// test/boot-monitor-matrix.test.ts holds every reviewed counterexample.
const lane = (key: string, status: LaneStatus): Lane => ({
  key,
  status,
  pane: `w1:${key}`,
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: "2026-01-01T12:00:00.000Z",
});

const manifest = (monitors: Monitor[]): Manifest => ({
  path: "/fixture/extensions/terminal/owner.json",
  data: {
    version: 1,
    sessionId: "owner",
    monitors: monitors.map((m) => ({ sessionId: "owner", persistent: true, monitorId: "mon_FIXTURE", ...m })),
  },
});

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("a legacy record whose argv holds a non-string is still matched by its command, as before", () => {
  const dir = join(state.dir, "legacy");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "owner.json"),
    JSON.stringify({
      version: 1,
      sessionId: "owner",
      monitors: [
        { sessionId: "owner", persistent: true, monitorId: "mon_TEST", argv: [7], command: "dori checkpoints api" },
      ],
    }),
  );
  const read = readMonitorManifests(join(state.dir, "missing"), [dir]);
  expect(read.errors).toEqual([]);
  expect(monitorCleanup([lane("api", "closed")], read.manifests).map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_TEST", ["api:command:key"]],
  ]);
});

test("a closed lane named in an argument position is still claimed, even when its key is a dori program name", () => {
  const lanes = ["dori", "omp-dori", "api-fix", "harness-lane"].map((key) => lane(key, "closed"));
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["dori", "checkpoints", "dori"], monitorId: "mon_DORI" },
      { argv: ["dori", "checkpoints", "omp-dori"], monitorId: "mon_OMP" },
      { command: "dori checkpoints dori", monitorId: "mon_COMMAND" },
      { argv: ["rg", "-n", "/src/omp-dori", "api-fix"], monitorId: "mon_PATH" },
      { argv: ["bun", "/repo/src/cli.ts", "send", "harness-lane", "hi"], monitorId: "mon_HARNESS" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_DORI", ["dori:argv:key"]],
    ["mon_OMP", ["omp-dori:argv:key"]],
    ["mon_COMMAND", ["dori:command:key"]],
    ["mon_PATH", ["api-fix:argv:key"]],
    ["mon_HARNESS", ["harness-lane:argv:key"]],
  ]);
});

test("a shared dori watch behind a launcher with options is still not claimed by its own command words", () => {
  const lanes = ["dori", "inbound", "slack"].map((key) => lane(key, "closed"));
  const argv = [
    ["env", "-u", "NODE_OPTIONS", "dori", "inbound", "slack"],
    ["env", "-i", "/home/user/.dori/bin/dori", "inbound", "slack"],
    ["timeout", "60", "dori", "inbound", "slack"],
    ["timeout", "--signal", "TERM", "60", "dori", "inbound", "slack"],
    ["nice", "-n", "10", "dori", "inbound", "slack"],
    ["stdbuf", "-oL", "dori", "inbound", "slack"],
    ["FOO=a b", "dori", "inbound", "slack"],
  ];
  const commands = [
    'FOO="a b" dori inbound slack',
    "env -u NODE_OPTIONS dori inbound slack",
    "bash -lc 'exec -a intake dori inbound slack'",
    'sh -c "nohup dori inbound slack"',
  ];
  const monitors = [...argv.map((words) => ({ argv: words })), ...commands.map((command) => ({ command }))];
  expect(monitorCleanup(lanes, [manifest(monitors)])).toEqual([]);
});

test("a relative cli.ts entry is dori's own, and an argument after its command still names a lane", () => {
  const lanes = ["freshness", "api-fix"].map((key) => lane(key, "closed"));
  const skill = "/w/skills/dori-mode/scripts";
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["bun", "src/cli.ts", "freshness"], cwd: skill, monitorId: "mon_SKILL" },
      { command: "bun run src/cli.ts freshness", cwd: skill, monitorId: "mon_SKILL_COMMAND" },
      { argv: ["bun", "src/cli.ts", "send", "api-fix", "hi"], cwd: "/w", monitorId: "mon_HARNESS" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([["mon_HARNESS", ["api-fix:argv:key"]]]);
});

test("a word after a dori program that is no dori command still names a lane: rg -c dori api-fix", () => {
  const result = monitorCleanup(
    [lane("api-fix", "closed")],
    [
      manifest([
        { argv: ["rg", "-c", "dori", "api-fix"], monitorId: "mon_ARGV" },
        { command: "rg -c dori api-fix", monitorId: "mon_COMMAND" },
      ]),
    ],
  );
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_ARGV", ["api-fix:argv:key"]],
    ["mon_COMMAND", ["api-fix:command:key"]],
  ]);
});

test("a shared dori watch inside a loop, a condition, a subshell, a cd or an env -C stays unclaimed", () => {
  const scripts = "/w/skills/dori-mode/scripts";
  const lanes = ["slack", "freshness"].map((key) => lane(key, "closed"));
  const monitors: Monitor[] = [
    { command: "while true; do dori inbound slack --loop 1; sleep 3; done" },
    { command: "while true; do exec dori inbound slack --loop 1; done" },
    { command: "if test -f /ready; then dori inbound slack --loop 1; fi" },
    { command: "( dori inbound slack --loop 1 )" },
    { command: `cd ${scripts} && bun src/cli.ts freshness`, cwd: "/repo" },
    { argv: ["env", "-C", scripts, "bun", "src/cli.ts", "freshness"], cwd: "/repo" },
    { argv: ["bun", "src/cli.ts", "freshness"], cwd: scripts },
    { argv: ["timeout", "-vk", "5", "60", "dori", "inbound", "slack"] },
    { command: "bash -O extglob -c 'exec dori inbound slack --loop 1'" },
  ];
  expect(monitorCleanup(lanes, [manifest(monitors)])).toEqual([]);
  // An open lane named anywhere still keeps the watch.
  const open = [lane("slack", "working"), lane("api", "closed")];
  expect(monitorCleanup(open, [manifest([{ command: "while true; do dori inbound slack; done # api" }])])).toEqual([]);
});

test("relayed is a command word, while its target still identifies a closed lane", () => {
  const lanes = ["relayed", "api"].map((key) => lane(key, "closed"));
  const receipt = "a".repeat(64);
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["dori", "relayed", "api", "--report", receipt], monitorId: "mon_ARGV" },
      { command: `dori relayed api --report ${receipt}`, monitorId: "mon_COMMAND" },
      { argv: ["dori", "relayed", "relayed", "--report", receipt], monitorId: "mon_TARGET" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_ARGV", ["api:argv:key"]],
    ["mon_COMMAND", ["api:command:key"]],
    ["mon_TARGET", ["relayed:argv:key"]],
  ]);
});

test.each(["owner", "report"])("report option values do not hide a messenger platform: %s", (option) => {
  const monitors: Monitor[] = [
    { argv: ["dori", "inbound", `--${option}`, "slack", "discord"] },
    { command: `dori inbound --${option} slack discord` },
  ];
  expect(monitorCleanup([lane("discord", "closed")], [manifest(monitors)])).toEqual([]);
});

test("lanes is a command word, but report can still target a lane named lanes", () => {
  const result = monitorCleanup(
    [lane("lanes", "closed")],
    [
      manifest([
        { argv: ["dori", "lanes", "--thread", "discord:123", "--open"], monitorId: "mon_ARGV" },
        { command: "dori lanes --open", monitorId: "mon_COMMAND" },
        { argv: ["dori", "report", "lanes", "--kind", "done", "--text", "complete"], monitorId: "mon_TARGET" },
      ]),
    ],
  );
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([["mon_TARGET", ["lanes:argv:key"]]]);
});

test("a Discord voice monitor does not belong to lanes named voice or discord", () => {
  const lanes = ["voice", "discord"].map((key) => lane(key, "closed"));
  const monitors = [{ argv: ["dori", "voice", "discord"] }, { command: "dori voice discord" }];
  expect(monitorCleanup(lanes, [manifest(monitors)])).toEqual([]);
});
