import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readPaneState } from "../../skills/cataly-mode/scripts/src/lane-state.ts";
import { ROLE_INVARIANTS } from "../role-invariants.ts";
import { bridgePreviousMain } from "../session-bridge.ts";
import { type FakePi, type FakeSession, load, until, useConfig } from "./fake-pi";

const PANE = "6200";
const agentStart = { type: "before_agent_start", prompt: "keep working", systemPrompt: ["base prompt"] };
const tick = { name: "tick", argv: ["sh", "-c", "echo up; exec sleep 30"], filter: "^up", cwd: tmpdir() };
const intake = { path: join(tmpdir(), "heartbeat"), monitor: "tick", maxAgeMs: 120_000 };
const binding = "/state/lanes/demo/policy.json";
const laneKey = "discord-lane";

/** The entries the previous main (47c4be0) wrote for a lead: its role, monitors, intake and bootstrap marker. */
const previousLead = (id: string) => [
  { type: "custom", customType: "omp-dori:role", data: "dori" },
  { type: "custom", customType: "omp-dori:monitor", data: { op: "start", ...tick, id: "record-1" } },
  { type: "custom", customType: "omp-dori:intake", data: intake },
  {
    type: "custom",
    customType: "omp-dori:monitor-bootstrap",
    data: { version: 1, sessionId: id, hash: "a".repeat(64) },
  },
];
/** The entries the previous main wrote for a lane: its role, receiver, ask-lane binding and policy. */
const previousLane = (id: string) => [
  { type: "custom", customType: "omp-dori:role", data: "lane" },
  { type: "custom", customType: "omp-dori:discord-lane-receiver", data: id },
  { type: "custom", customType: "omp-dori:discord-ask-lane", data: { key: laneKey, sessionId: id } },
  { type: "custom", customType: "omp-dori:lane-policy", data: binding },
];
const session = (id: string, entries: FakeSession["entries"] = []): FakeSession => ({
  id,
  file: `/sessions/${id}.jsonl`,
  entries,
});
const run = (pi: FakePi, params: Record<string, unknown>) =>
  pi.tools.get("monitor")!.execute("call", params, undefined, undefined, pi.ctx());
const monitorCall = async (pi: FakePi, params: Record<string, unknown>): Promise<string> =>
  (await run(pi, params)).content[0]?.text ?? "";
const sessions: FakePi[] = [];
const pids = new Set<number>();
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const previousEnv = new Map<string, string | undefined>();
let stateDir: string;

beforeEach(() => {
  for (const key of ["CATALY_CONFIG", "CATALY_STATE_DIR", "TERN_PANE", "CATALY_LANE_POLICY"])
    previousEnv.set(key, process.env[key]);
  stateDir = useConfig();
  process.env.TERN_PANE = PANE;
  delete process.env.CATALY_LANE_POLICY;
});
afterEach(async () => {
  for (const pi of sessions.splice(0)) await pi.emit("session_shutdown");
  await until(() => [...pids].every((pid) => !alive(pid)));
  pids.clear();
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
});

const record = (branch: FakeSession["entries"]) => {
  const plan: { customType: string; data?: unknown }[] = [];
  bridgePreviousMain((customType, data) => void plan.push({ customType, data }), branch);
  return plan;
};

test("the previous main's role becomes the current role, once", () => {
  expect(record([{ type: "custom", customType: "omp-dori:role", data: "dori" }])).toEqual([
    { customType: "omp-cataly:role", data: "cataly" },
  ]);
  // Only the newest parseable role is the state; an older one is not replayed.
  expect(
    record([
      { type: "custom", customType: "omp-dori:role", data: "lane" },
      { type: "custom", customType: "omp-dori:role", data: "dori" },
    ]),
  ).toEqual([{ customType: "omp-cataly:role", data: "cataly" }]);
  // A branch that already carries the state appends nothing.
  expect(
    record([
      { type: "custom", customType: "omp-dori:role", data: "dori" },
      { type: "custom", customType: "omp-cataly:role", data: "cataly" },
    ]),
  ).toEqual([]);
});

test("the newest monitor record per name is replayed in its original order", () => {
  const started = { op: "start", ...tick, id: "one" };
  expect(
    record([
      { type: "custom", customType: "omp-dori:monitor", data: started },
      { type: "custom", customType: "omp-dori:monitor", data: { op: "stop", name: tick.name, id: "one" } },
      { type: "custom", customType: "omp-dori:monitor", data: { op: "start", ...tick, name: "other", id: "two" } },
    ]),
  ).toEqual([{ customType: "omp-cataly:monitor", data: { op: "start", ...tick, name: "other", id: "two" } }]);
  // A monitor the current entries started and the previous main stopped is stopped again.
  expect(
    record([
      { type: "custom", customType: "omp-cataly:monitor", data: started },
      { type: "custom", customType: "omp-dori:monitor", data: { op: "stop", name: tick.name } },
    ]),
  ).toEqual([{ customType: "omp-cataly:monitor", data: { op: "stop", name: tick.name } }]);
});

test("receipts and completion records keep their newest state under the current names", () => {
  const admission = { identity: "1:2:3:4", fingerprint: "b".repeat(64) };
  expect(
    record([
      { type: "custom", customType: "omp-dori:admission-rejected", data: { ompDoriAdmission: admission } },
      {
        type: "custom",
        customType: "omp-dori:tool-completion",
        data: { call: "c", job: "j", tool: "bash", cwd: "/w" },
      },
    ]),
  ).toEqual([
    { customType: "omp-cataly:tool-completion", data: { call: "c", job: "j", tool: "bash", cwd: "/w" } },
    { customType: "omp-cataly:admission-rejected", data: { ompCatalyAdmission: admission } },
  ]);
  // An accepted receipt is newer than the rejection, and the readers resolve that message kind themselves, so the
  // rejection is not replayed.
  expect(
    record([
      { type: "custom", customType: "omp-dori:admission-rejected", data: { ompDoriAdmission: admission } },
      { type: "custom_message", customType: "dori-monitor", details: { ompDoriAdmission: admission } },
    ]),
  ).toEqual([]);
});

test("a lead resumed from the previous main keeps its role, monitors, intake and bootstrap", async () => {
  const id = "previous-lead";
  const s = session(id, previousLead(id));
  const resumed = await load({ session: s });
  sessions.push(resumed);
  await resumed.emit("session_start");
  expect(readPaneState(stateDir, PANE)).toMatchObject({ role: "cataly", sessionId: id });
  expect(await resumed.emit("before_agent_start", agentStart)).toContainEqual({
    systemPrompt: ["base prompt", ROLE_INVARIANTS.cataly],
  });
  expect(resumed.messages[0]).toEqual({
    content: "[monitor] restored for this resumed session: tick",
    options: { triggerTurn: false },
  });
  const listed = await monitorCall(resumed, { op: "list" });
  expect(listed).toContain("tick (pid");
  pids.add(Number(/pid (\d+)/.exec(listed)?.[1]));
  await until(() => resumed.messages.some((m) => m.content === "[tick] up"));
  expect(JSON.parse(readFileSync(join(stateDir, "monitors", `${id}.json`), "utf8"))).toMatchObject({
    sessionId: id,
    monitors: [tick],
    intake,
  });
  const wire = s.entries.map(({ customType, data }) => ({ customType, data }));
  expect(wire).toEqual([
    { customType: "omp-dori:role", data: "dori" },
    { customType: "omp-dori:monitor", data: { op: "start", ...tick, id: "record-1" } },
    { customType: "omp-dori:intake", data: intake },
    { customType: "omp-dori:monitor-bootstrap", data: previousLead(id)[3]!.data },
    { customType: "omp-cataly:role", data: "cataly" },
    { customType: "omp-cataly:monitor", data: { op: "start", ...tick, id: "record-1" } },
    { customType: "omp-cataly:intake", data: intake },
    { customType: "omp-cataly:monitor-bootstrap", data: previousLead(id)[3]!.data },
  ]);
});

test("a second resume of the same lead appends nothing", async () => {
  const id = "previous-lead-again";
  const s = session(id, previousLead(id));
  const first = await load({ session: s });
  sessions.push(first);
  await first.emit("session_start");
  pids.add(Number(/pid (\d+)/.exec(await monitorCall(first, { op: "list" }))?.[1]));
  await first.emit("session_shutdown");
  await until(() => [...pids].every((pid) => !alive(pid)));
  const written = s.entries.length;

  const second = await load({ session: s });
  sessions.push(second);
  await second.emit("session_start");
  expect(s.entries).toHaveLength(written);
  expect(readPaneState(stateDir, PANE)).toMatchObject({ role: "cataly", sessionId: id });
  const listed = await monitorCall(second, { op: "list" });
  expect(listed).toContain("tick (pid");
  pids.add(Number(/pid (\d+)/.exec(listed)?.[1]));
});

test("a lane resumed from the previous main keeps its role, policy, receiver and ask lane", async () => {
  const id = "previous-lane";
  const s = session(id, previousLane(id));
  const resumed = await load({ session: s, mode: "tui" });
  sessions.push(resumed);
  await resumed.emit("session_start");
  expect(readPaneState(stateDir, PANE)).toMatchObject({
    role: "lane",
    sessionId: id,
    discordLaneKey: laneKey,
  });
  // A lane that owns its receiver drains its own channel; the shared inbox flag is only for one that does not.
  expect(readPaneState(stateDir, PANE)).not.toHaveProperty("discordLaneInbox");
  expect(await resumed.emit("before_agent_start", agentStart)).toContainEqual({
    systemPrompt: ["base prompt", ROLE_INVARIANTS.lane],
  });
  const blocked = await resumed.emit("tool_call", {
    type: "tool_call",
    toolName: "bash",
    input: { command: "sudo true" },
  });
  expect(blocked).toContainEqual(expect.objectContaining({ block: true }));
  const appended = s.entries.slice(4).map(({ customType, data }) => ({ customType, data }));
  expect(appended).toHaveLength(4);
  expect(appended).toContainEqual({ customType: "omp-cataly:role", data: "lane" });
  expect(appended).toContainEqual({ customType: "omp-cataly:discord-lane-receiver", data: id });
  expect(appended).toContainEqual({ customType: "omp-cataly:discord-ask-lane", data: { key: laneKey, sessionId: id } });
  expect(appended).toContainEqual({ customType: "omp-cataly:lane-policy", data: binding });
});

test("a mixed session resumes with the newest state of each type", async () => {
  const id = "mixed-previous";
  const s = session(id, [
    { type: "custom", customType: "omp-cataly:role", data: "lane" },
    { type: "custom", customType: "omp-cataly:monitor", data: { op: "start", ...tick, id: "old" } },
    { type: "custom", customType: "omp-dori:role", data: "dori" },
    { type: "custom", customType: "omp-dori:monitor", data: { op: "stop", name: tick.name } },
    { type: "custom", customType: "omp-dori:monitor", data: { op: "start", ...tick, name: "later", id: "new" } },
  ]);
  const resumed = await load({ session: s });
  sessions.push(resumed);
  await resumed.emit("session_start");
  // The newest role is the previous main's "dori", which is the lead role.
  expect(readPaneState(stateDir, PANE)).toMatchObject({ role: "cataly", sessionId: id });
  const listed = await monitorCall(resumed, { op: "list" });
  expect(listed).toContain("later (pid");
  expect(listed).not.toContain("tick (pid");
  pids.add(Number(/pid (\d+)/.exec(listed)?.[1]));
  expect(resumed.messages[0]).toEqual({
    content: "[monitor] restored for this resumed session: later",
    options: { triggerTurn: false },
  });
  expect(s.entries.slice(5).map(({ customType, data }) => ({ customType, data }))).toEqual([
    { customType: "omp-cataly:role", data: "cataly" },
    { customType: "omp-cataly:monitor", data: { op: "stop", name: tick.name } },
    { customType: "omp-cataly:monitor", data: { op: "start", ...tick, name: "later", id: "new" } },
  ]);
});

test("a previous-main lane session file gains the current entries exactly once", async () => {
  const { nativePolicy } = await import("../../test/fixtures/omp-native-host/policy-host.ts");
  const id = "previous-file";
  const file = join(dirname(stateDir), "previous-file.jsonl");
  const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: tmpdir() };
  const original = [header, ...previousLane(id)];
  writeFileSync(file, `${original.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const entry = join(import.meta.dir, "../index.ts");
  const current = (rows: readonly { type: string; customType?: string; data?: unknown }[]) =>
    rows
      .filter((row) => row.type === "custom" && row.customType?.startsWith("omp-cataly:"))
      .map(({ customType, data }) => ({ customType, data }));
  await nativePolicy(entry, { session: { file } });
  const after = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(current(after)).toHaveLength(4);
  expect(current(after)).toContainEqual({ customType: "omp-cataly:role", data: "lane" });
  expect(current(after)).toContainEqual({ customType: "omp-cataly:discord-lane-receiver", data: id });
  expect(current(after)).toContainEqual({
    customType: "omp-cataly:discord-ask-lane",
    data: { key: laneKey, sessionId: id },
  });
  expect(current(after)).toContainEqual({ customType: "omp-cataly:lane-policy", data: binding });
  // OMP's own entries are untouched, including the previous main's four.
  expect(after.filter((row) => row.customType?.startsWith("omp-dori:"))).toHaveLength(4);

  // A second resume of the same file appends nothing.
  await nativePolicy(entry, { session: { file } });
  expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(after.length);
});
