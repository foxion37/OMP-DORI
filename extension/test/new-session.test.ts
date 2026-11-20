import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPaneState } from "../../skills/dori-mode/scripts/src/lane-state";
import { readMonitorSet } from "../../src/update/deployment-monitors.ts";
import { ROLE_INVARIANTS } from "../role-invariants.ts";
import { type FakePi, type FakeSession, load, until, useConfig } from "./fake-pi";

const PANE = "w1:p61";
const ROLE = "omp-dori:role";
const MONITOR = "omp-dori:monitor";
const agentStart = { type: "before_agent_start", prompt: "ulw keep working", systemPrompt: ["base prompt"] };
const roleEntry = (role: string) => ({ type: "custom", customType: ROLE, data: role });
const session = (id: string, entries: FakeSession["entries"] = []): FakeSession => ({
  id,
  file: `/sessions/${id}.jsonl`,
  entries,
});
const spec = { name: "inbound", argv: ["sleep", "30"], filter: ".", cwd: tmpdir() };
const run = (pi: FakePi, params: Record<string, unknown>) =>
  pi.tools.get("monitor")!.execute("call", params, undefined, undefined, pi.ctx());
const sessions: FakePi[] = [];
const pids = new Set<number>();
const previousEnv = new Map<string, string | undefined>();
const posix = test.skipIf(process.platform === "win32");
let stateDir: string;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const runningPid = async (pi: FakePi): Promise<number> => {
  const listed = (await run(pi, { op: "list" })).content[0]?.text ?? "";
  expect(listed.split("\n")).toHaveLength(1);
  const pid = Number(/pid (\d+)/.exec(listed)?.[1]);
  expect(pid).toBeGreaterThan(0);
  pids.add(pid);
  expect(alive(pid)).toBe(true);
  return pid;
};

beforeEach(() => {
  for (const key of ["DORI_CONFIG", "DORI_STATE_DIR", "HERDR_PANE_ID", "HC_TERMINAL_ID", "DORI_MANAGED_STARTUP"])
    previousEnv.set(key, process.env[key]);
  stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  process.env.HERDR_PANE_ID = PANE;
  delete process.env.HC_TERMINAL_ID;
  delete process.env.DORI_MANAGED_STARTUP;
});
afterEach(async () => {
  try {
    const beforeShutdown = readPaneState(stateDir, PANE);
    for (const pi of sessions.splice(0)) await pi.emit("session_shutdown");
    await until(() => [...pids].every((pid) => !alive(pid)));
    if (beforeShutdown)
      expect(readPaneState(stateDir, PANE)).toMatchObject({
        ...beforeShutdown,
        pid: 0,
        agentStatus: "idle",
        approvalPending: false,
        updatedAt: expect.any(String),
      });
    else expect(readPaneState(stateDir, PANE)).toBeNull();
  } finally {
    pids.clear();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
  }
});

test("a new lane carries only its role and resets goal, approvals and working state", async () => {
  const started = session("lane-old", [
    { type: "mode_change", mode: "goal", data: { goal: { objective: "old objective", status: "active" } } },
    { type: "custom", customType: "unrelated", data: "old session data" },
  ]);
  const pi = await load({ session: started, flags: { "dori-role": "lane" } });
  sessions.push(pi);
  await pi.emit("session_start");
  await pi.emit("tool_approval_requested", { toolCallId: "old-approval" });
  await pi.emit("agent_start");
  expect(readPaneState(stateDir, PANE)).toMatchObject({
    goal: { status: "active", objective: "old objective" },
    approvalPending: true,
    agentStatus: "working",
  });

  const fresh = session("lane-new");
  pi.session = fresh;
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  expect(fresh.entries).toEqual([roleEntry("lane")]);
  expect(pi.active).toEqual(["read", "bash", "goal"]);
  expect(readPaneState(stateDir, PANE)).toMatchObject({
    role: "lane",
    sessionId: fresh.id,
    sessionFile: fresh.file,
    goal: { status: "none" },
    approvalPending: false,
    agentStatus: "idle",
  });
  expect(await pi.emit("before_agent_start", agentStart)).toContainEqual({
    systemPrompt: ["base prompt", ROLE_INVARIANTS.lane, "<fake-ulw-policy>"],
  });
  await expect(run(pi, { op: "list" })).rejects.toThrow("monitor works only in the Dori session");
  await pi.emit("tool_approval_resolved", { toolCallId: "old-approval" });
  expect(readPaneState(stateDir, PANE)?.approvalPending).toBe(false);
});

test.each([
  ["session_switch", "resume"],
  ["session_switch", "fork"],
  ["session_branch", "branch"],
  ["session_branch", "fork"],
  ["session_tree", undefined],
] as const)("%s with reason %s does not carry a Dori role or monitors into a plain branch", async (event, reason) => {
  const started = session("dori-old");
  const pi = await load({ session: started, flags: { "dori-role": "dori" } });
  sessions.push(pi);
  await pi.emit("session_start");
  await run(pi, { op: "start", ...spec });
  const oldPid = await runningPid(pi);
  const plain = session(event === "session_tree" ? started.id : "plain-destination");
  pi.session = plain;
  await pi.emit(event, { type: event, ...(reason === undefined ? {} : { reason }) });
  await until(() => !alive(oldPid));
  expect(plain.entries).toEqual([]);
  expect(pi.active).toEqual(["read", "bash"]);
  expect(readPaneState(stateDir, PANE)).toBeNull();
  expect(await pi.emit("before_agent_start", agentStart)).toEqual([undefined]);
  await expect(run(pi, { op: "list" })).rejects.toThrow("monitor works only in the Dori session");
  await pi.emit("tool_approval_requested", { toolCallId: "plain-approval" });
  expect(readPaneState(stateDir, PANE)).toBeNull();

  // The original process flag cannot reactivate a role after an ordinary resume, fork or tree move cleared it.
  const fresh = session("plain-new");
  pi.session = fresh;
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  expect(fresh.entries).toEqual([]);
  expect(pi.active).toEqual(["read", "bash"]);
  expect(readPaneState(stateDir, PANE)).toBeNull();
});

test.each(["dori", "lane"] as const)("a recorded %s destination overrides role and monitor carry", async (role) => {
  const pi = await load({ session: session("dori-old"), flags: { "dori-role": "dori" } });
  sessions.push(pi);
  await pi.emit("session_start");
  await run(pi, { op: "start", ...spec });
  const oldPid = await runningPid(pi);
  const destinationSpec = { ...spec, name: "destination" };
  const entries = [roleEntry(role), { type: "custom", customType: MONITOR, data: { op: "start", ...destinationSpec } }];
  const destination = session("recorded-destination", [...entries]);
  pi.session = destination;
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  await until(() => !alive(oldPid));
  expect(destination.entries).toEqual(entries);
  expect(readPaneState(stateDir, PANE)).toMatchObject({ role, sessionId: destination.id });
  if (role === "dori") {
    await runningPid(pi);
    expect((await run(pi, { op: "list" })).content[0]?.text).toContain("destination (pid");
    expect((await run(pi, { op: "list" })).content[0]?.text).not.toContain("inbound (pid");
    expect(pi.active).toEqual(["read", "bash", "monitor"]);
  } else {
    expect(pi.active).toEqual(["read", "bash", "goal"]);
    await expect(run(pi, { op: "list" })).rejects.toThrow("monitor works only in the Dori session");
  }
});

// POSIX-only: reads the 0o600 bootstrap the product verifies by mode and owner uid, and sends SIGTERM.
posix("a new Dori session does not reapply its original session-bound bootstrap", async () => {
  const started = session("bootstrap-old");
  const bootstrap = join(stateDir, "..", "bootstrap.json");
  const intake = { path: join(stateDir, "heartbeat"), monitor: spec.name, maxAgeMs: 120_000 };
  writeFileSync(bootstrap, JSON.stringify({ version: 1, sessionId: started.id, monitors: [spec], intake }), {
    mode: 0o600,
  });
  const pi = await load({ session: started, flags: { "dori-role": "dori", "dori-monitor-bootstrap": bootstrap } });
  sessions.push(pi);
  await pi.emit("session_start");
  expect(started.entries.at(-1)).toEqual(roleEntry("dori"));
  expect(started.entries.filter((entry) => entry.customType === "omp-dori:monitor-bootstrap")).toHaveLength(1);
  const oldPid = await runningPid(pi);

  const fresh = session("bootstrap-new");
  pi.session = fresh;
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  const saved = join(stateDir, "monitors", `${fresh.id}.json`);
  // Intake routing belongs to the monitors, not to the old session's private bootstrap token.
  expect(readMonitorSet(saved, fresh.id, true)).toMatchObject({ sessionId: fresh.id, monitors: [spec], intake });
  expect(fresh.entries).toEqual([
    roleEntry("dori"),
    { type: "custom", customType: MONITOR, data: { op: "start", ...spec } },
    { type: "custom", customType: "omp-dori:intake", data: intake },
  ]);
  await until(() => !alive(oldPid));
  const exitedPid = await runningPid(pi);
  expect(JSON.parse(readFileSync(saved, "utf8"))).toEqual({
    version: 1,
    sessionId: fresh.id,
    monitors: [spec],
    intake,
  });

  // A poller exit is not a recorded stop: a later /new must retain its desired start and intake.
  process.kill(exitedPid, "SIGTERM");
  await until(() => !alive(exitedPid));
  const afterExit = session("bootstrap-after-exit");
  pi.session = afterExit;
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  expect(readMonitorSet(join(stateDir, "monitors", `${afterExit.id}.json`), afterExit.id, true)).toMatchObject({
    sessionId: afterExit.id,
    monitors: [spec],
    intake,
  });
  await runningPid(pi);
});

// POSIX-only: reads the 0o600 bootstrap the product verifies by mode and owner uid.
posix.each([false, true])("rejected bootstrap cannot seed a new session (recorded: %s)", async (recorded) => {
  const started = session("bootstrap-rejected", recorded ? [roleEntry("dori")] : []);
  const bootstrap = join(stateDir, "..", "bootstrap.json");
  const intake = { path: join(stateDir, "heartbeat"), monitor: spec.name, maxAgeMs: 120_000 };
  writeFileSync(bootstrap, JSON.stringify({ version: 1, sessionId: "other-session", monitors: [spec], intake }), {
    mode: 0o600,
  });
  const pi = await load({ session: started, flags: { "dori-role": "dori", "dori-monitor-bootstrap": bootstrap } });
  sessions.push(pi);
  await expect(pi.emit("session_start")).rejects.toThrow("session or version");
  expect(started.entries).toEqual(recorded ? [roleEntry("dori")] : []);
  await pi.emit("session_tree");
  await pi.emit("session_branch");
  await pi.emit("agent_start");
  await pi.emit("tool_approval_requested", { toolCallId: "rejected-approval" });
  expect(readPaneState(stateDir, PANE)).toBeNull();
  await expect(run(pi, { op: "list" })).rejects.toThrow("monitor works only in the Dori session");

  const fresh = session("after-rejection");
  pi.session = fresh;
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  expect(fresh.entries).toEqual([]);
  expect(pi.active).toEqual(["read", "bash"]);
  expect(readPaneState(stateDir, PANE)).toBeNull();
  expect(await pi.emit("before_agent_start", agentStart)).toEqual([undefined]);
});
