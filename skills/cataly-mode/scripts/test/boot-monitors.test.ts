import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, type Monitor, monitorCleanup, readMonitorManifests } from "../src/boot-monitors.ts";
import { reconcilePanes } from "../src/reconcile.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { href, sid, type TestState, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const lane = (key: string, status: LaneStatus = "working", pane = `w1:${key}`): Lane => ({
  key,
  status,
  sessionRef: { runtime: "tern", id: pane },
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
});

/** A desired-monitor spec; `cwd` defaults to "/repo". */
const watch = (name: string, argv: string[], extra: Partial<Monitor> = {}): Monitor => ({
  name,
  argv,
  cwd: "/repo",
  ...extra,
});

const manifest = (monitors: Monitor[]): Manifest => ({
  path: "/fixture/monitors/owner.json",
  data: { version: 1, sessionId: "owner", monitors },
});

let state: TestState;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

test("vanished, live and unassigned sessions reconcile without mutating the lane records", () => {
  // Given lanes whose sessions are gone, live, or never assigned.
  const lanes = [
    { ...lane("old"), sessionRef: href(sid(8)) },
    { ...lane("current"), sessionRef: href(sid(2)) },
    (({ sessionRef: _unassigned, ...pending }) => pending)(lane("pending")),
  ];
  const before = JSON.stringify(lanes);
  // When reconciled against the live session list.
  const result = reconcilePanes(lanes, [
    { ref: href(sid(1)), status: "idle" },
    { ref: href(sid(2)), status: "working" },
  ]);
  // Then each lane is classified, unowned sessions are listed, and the input is untouched.
  expect(result.lanes.map((l) => l.paneState)).toEqual(["vanished", "live", "unassigned"]);
  expect(result.unregistered).toEqual([sid(1)]);
  expect(JSON.stringify(lanes)).toBe(before);
});

test("watches on closed or verified lanes become owner-scoped stop calls", () => {
  // Given watches for closed, verified and still-claimed lanes.
  const lanes = [lane("closed", "closed"), lane("verified", "verified-done"), lane("claimed", "done-claimed")];
  const input = manifest([
    watch("CLOSED", ["cataly", "watch", "closed"]),
    watch("VERIFIED", ["tern", "read", "w1:verified"]),
    watch("CLAIMED", ["cataly", "watch", "claimed"]),
  ]);
  // When cleanup candidates are computed.
  const result = monitorCleanup(lanes, [input]);
  // Then only watches of finished lanes are listed, with the owner's exact stop call.
  expect(result.map((m) => m.monitorId)).toEqual(["CLOSED", "VERIFIED"]);
  expect(result[0]?.stop).toBe('monitor({"op":"stop","name":"CLOSED"})');
  expect(result[0]?.sessionId).toBe("owner");
  expect(result[0]?.metadata).toBe(input.path);
});

test("shared, prefix-matched and unknown watches are preserved", () => {
  // Given a closed lane whose key is a prefix of an active one, and watches of every risky shape.
  const lanes = [lane("api", "closed"), lane("api-release"), lane("closed", "closed")];
  const result = monitorCleanup(lanes, [
    manifest([
      watch("ACTIVE", ["cataly", "watch", "api-release"]),
      watch("SHARED", ["cataly", "watch", "closed", "api-release"]),
      watch("UNKNOWN", ["bun", "presence.ts"], { filter: "unrelated presence" }),
    ]),
  ]);
  // Then none is offered for cleanup.
  expect(result).toEqual([]);
});

test("an active lane named after a colon or before a period or colon still keeps a shared watch", () => {
  // Given a closed lane, an active one, and a closed key that appears only inside a dotted name.
  const lanes = [lane("closed", "closed"), lane("api-release"), lane("v2", "closed")];
  const closed = ["cataly", "watch", "closed"];
  const result = monitorCleanup(lanes, [
    manifest([
      watch("COLON", closed, { filter: "closed reports; lane:api-release" }),
      watch("PERIOD", closed, { filter: "closed reports, then api-release." }),
      watch("TRAILCOLON", closed, { cwd: "/logs/api-release: both" }),
      watch("DOTTED", ["cataly", "watch", "api.v2"]),
      watch("CLOSED", closed),
    ]),
  ]);
  // Then only the watch naming nothing but the closed lane is offered.
  expect(result.map((m) => m.monitorId)).toEqual(["CLOSED"]);
});

test("a common-word key ties a watch to its lane only as an argv word, never in prose or a path", () => {
  // Given a closed lane keyed "docs" and watches that name it in prose, in a path, as a word and by pane.
  const lanes = [lane("docs", "closed")];
  const result = monitorCleanup(lanes, [
    manifest([
      watch("PROSE", ["gh", "run", "watch", "4242"], { filter: "CI for the docs site on main" }),
      watch("PATH", ["tail", "-F", "build/docs/out.log"]),
      watch("KEY", ["cataly", "report-watch", "docs"]),
      watch("PANE", ["tern", "read", "w1:docs"]),
    ]),
  ]);
  // Then only the word and pane watches are offered, each with what matched.
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["KEY", ["docs:argv:key"]],
    ["PANE", ["docs:argv:pane"]],
  ]);
});

test("a done journal qualifies a lane for cleanup on its own; halted does not", () => {
  // Given two working lanes whose journals say done and halted.
  const lanes = [
    { ...lane("done-report"), reportState: "done" as const },
    { ...lane("halted-report"), reportState: "halted" as const },
  ];
  // When cleanup candidates are computed.
  const cleanup = monitorCleanup(lanes, [
    manifest([
      watch("DONE", ["cataly", "watch", "done-report"]),
      watch("HALTED", ["cataly", "watch", "halted-report"]),
    ]),
  ]);
  // Then only the done lane's watch is listed.
  expect(cleanup.map((m) => m.monitorId)).toEqual(["DONE"]);
});

test("metadata discovery reads only the monitors directory's own JSON files, never nested state", () => {
  // Given a monitors directory with nested state, a non-JSON file and one manifest.
  const dir = join(state.dir, "monitors");
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), "not JSON: never inspect");
  writeFileSync(join(dir, "state", "private.json"), "not JSON: never inspect");
  writeFileSync(join(dir, "owner.json"), JSON.stringify(manifest([]).data));
  // When manifests are read; then only the manifest is.
  const read = readMonitorManifests(dir);
  expect(read.manifests.map((m) => m.path)).toEqual([join(dir, "owner.json")]);
  expect(read.errors).toEqual([]);
});

test("OMP desired specs retain argv boundaries, owner scope and open-lane guards", () => {
  const ompDir = join(state.dir, "monitors");
  mkdirSync(ompDir);
  const specs = [
    { name: "closed-watch", argv: ["cataly", "watch", "closed"], filter: "REPORT", cwd: "/repo" },
    { name: "quoted-argument", argv: ["notify", "closed and something else"], cwd: "/repo" },
    { name: "watch open", argv: ["cataly", "watch", "closed"], cwd: "/repo" },
    { name: "cwd-watch", argv: ["cataly", "watch", "closed"], cwd: "/repo/open" },
    { name: "filter-watch", argv: ["cataly", "watch", "closed"], filter: "^open$", cwd: "/repo" },
    { name: "pane-watch", argv: ["tern", "read", "7"], cwd: "/repo" },
    { name: "ref-watch", argv: ["cataly", "harness", "send", "tern:7"], cwd: "/repo" },
  ];
  const path = join(ompDir, "owner.json");
  writeFileSync(path, JSON.stringify({ version: 1, sessionId: "owner", monitors: specs }));
  const read = readMonitorManifests(ompDir);
  expect(read.errors).toEqual([]);
  const result = monitorCleanup(
    [lane("closed", "closed"), lane("open"), lane("tern-lane", "closed", "7")],
    read.manifests,
  );
  expect(result.map((entry) => entry.monitorId).sort()).toEqual(["closed-watch", "pane-watch", "ref-watch"]);
  expect(result.find((entry) => entry.monitorId === "closed-watch")).toMatchObject({
    sessionId: "owner",
    metadata: path,
    match: ["closed:argv:key"],
    stop: 'monitor({"op":"stop","name":"closed-watch"})',
  });
  expect(result.find((entry) => entry.monitorId === "pane-watch")?.match).toEqual(["tern-lane:argv:pane"]);
  expect(result.find((entry) => entry.monitorId === "ref-watch")?.match).toEqual(["tern-lane:argv:pane"]);
});

test("malformed OMP desired metadata is reported without hiding valid specs", () => {
  const ompDir = join(state.dir, "monitors");
  mkdirSync(ompDir);
  const bad = join(ompDir, "bad.json");
  writeFileSync(
    bad,
    JSON.stringify({
      version: 1,
      sessionId: "owner",
      monitors: [{ name: "bad", argv: "cataly watch closed", cwd: "/repo" }],
    }),
  );
  writeFileSync(
    join(ompDir, "good.json"),
    JSON.stringify({
      version: 1,
      sessionId: "owner",
      monitors: [{ name: "good", argv: ["cataly", "watch", "closed"], cwd: "/repo" }],
    }),
  );
  const read = readMonitorManifests(ompDir);
  expect(read.errors).toEqual([bad]);
  expect(monitorCleanup([lane("closed", "closed")], read.manifests).map((entry) => entry.monitorId)).toEqual(["good"]);
});

test("a closed lane named after a cataly program, command or platform word does not claim a shared cataly watch", () => {
  const lanes = ["cataly", "inbound", "slack", "freshness", "tail"].map((key) => lane(key, "closed"));
  const result = monitorCleanup(lanes, [
    manifest([
      watch("INBOUND", ["cataly", "inbound", "slack", "--loop", "1"]),
      watch("FRESHNESS", ["/home/user/.cataly/bin/cataly", "freshness", "--loop", "1"]),
      watch("COMMAND", ["sh", "-c", "cataly inbound slack --loop 1"]),
      watch("WRAPPED", ["sh", "-c", 'bash -c "cd /srv && exec cataly inbound slack --loop 1"']),
      watch("SOURCE", ["bun", "/opt/cataly/skills/cataly-mode/scripts/src/cli.ts", "freshness"]),
      watch("TAIL", ["sh", "-c", "tail -F /logs/out.log"]),
      watch("LANE", ["cataly", "report-watch", "slack"]),
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([["LANE", ["slack:argv:key"]]]);
});
