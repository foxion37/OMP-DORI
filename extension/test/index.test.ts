import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { paneStatePath, readPaneState, writePaneState } from "../../skills/cataly-mode/scripts/src/lane-state";
import { extensionInstallation } from "../installation.ts";
import { ROLE_INVARIANTS } from "../role-invariants.ts";
import { calls, type FakePi, type FakeSession, load, until, useConfig } from "./fake-pi";

const PANE = "5002";
const ROLE = "omp-cataly:role";
const posix = test.skipIf(process.platform === "win32");

const session = (id: string, entries: FakeSession["entries"] = []): FakeSession => ({
  id,
  file: `/sessions/${id}.jsonl`,
  entries,
});
const roleEntry = (role: string) => ({ type: "custom", customType: ROLE, data: role });
const wireRole = (role: "cataly" | "lane") => ({ type: "custom", customType: "omp-cataly:role", data: role });
const agentStart = { type: "before_agent_start", prompt: "fix the bug", systemPrompt: ["base prompt"] };

let stateDir: string;
beforeEach(() => {
  calls.length = 0;
  stateDir = useConfig();
  process.env.TERN_PANE = PANE;
});
afterEach(() => {
  delete process.env.TERN_PANE;
});

describe("role", () => {
  const lead = roleEntry("cataly");
  test.each([
    { entries: [lead], role: "cataly" },
    { entries: [lead, roleEntry("lane")], role: "lane" },
    { entries: [roleEntry("lane"), lead], role: "cataly" },
    { entries: [lead, { ...roleEntry("lane"), customType: "foreign:role" }], role: "cataly" },
  ] as const)("the newest recorded role owns the resumed session %#", async ({ entries, role }) => {
    const recorded = [...entries];
    const s = session("mixed-role", recorded);
    const pi = await load({ session: s, flags: { "cataly-role": role === "lane" ? "cataly" : "lane" } });
    try {
      await pi.emit("session_start");
      expect(readPaneState(stateDir, PANE)?.role).toBe(role);
      expect(pi.active.includes("monitor")).toBe(role === "cataly");
      expect(await pi.emit("before_agent_start", agentStart)).toContainEqual({
        systemPrompt: ["base prompt", ROLE_INVARIANTS[role]],
      });
      expect(s.entries.filter((entry) => entry.customType === ROLE)).toEqual(
        [...entries].filter((entry) => entry.customType !== "foreign:role"),
      );
    } finally {
      await pi.emit("session_shutdown");
    }
  });

  test("a consumer release selects its home config and a resumed lane writes its pane there", async () => {
    const names = ["CATALY_CONFIG", "CATALY_HOME"] as const;
    const previous = names.map((name) => [name, process.env[name]] as const);
    const home = join(dirname(stateDir), "install");
    const homeState = join(home, "state");
    const homeConfig = join(home, "config.json");
    mkdirSync(home);
    writeFileSync(homeConfig, JSON.stringify({ stateDir: homeState }));
    const retired = {
      paneId: PANE,
      role: "lane",
      sessionId: "flagless-lane",
      cwd: tmpdir(),
      pid: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      goal: { status: "none" },
      approvalPending: false,
    } as const;
    writePaneState(homeState, retired);
    let pi: FakePi | undefined;
    try {
      delete process.env.CATALY_CONFIG;
      delete process.env.CATALY_HOME;
      const physicalSource = join(home, "releases", "releases", `${"a".repeat(40)}-${"b".repeat(16)}`);
      mkdirSync(physicalSource, { recursive: true });
      const physicalHome = realpathSync(home);
      expect(extensionInstallation(physicalSource)).toMatchObject({
        configFile: join(physicalHome, "config.json"),
        env: { CATALY_HOME: physicalHome },
        ordinaryPaneRoot: false,
      });
      process.env.CATALY_CONFIG = homeConfig;
      process.env.CATALY_HOME = home;
      pi = await load({ session: session(retired.sessionId, [wireRole("lane")]), mode: "tui" });
      await pi.emit("session_start");
      await pi.emit("tool_approval_requested", { toolCallId: "resumed-approval" });
      expect(readPaneState(homeState, PANE)).toMatchObject({
        sessionId: retired.sessionId,
        pid: process.pid,
        approvalPending: true,
      });
      expect(await pi.emit("before_agent_start", agentStart)).toContainEqual({
        systemPrompt: ["base prompt", ROLE_INVARIANTS.lane],
      });
      expect(readPaneState(stateDir, PANE)).toBeNull();
      expect(process.env.CATALY_HOME).toBe(home);
      expect(process.env.CATALY_CONFIG).toBe(homeConfig);
    } finally {
      await pi?.emit("session_shutdown");
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("--cataly-role is recorded on session start and restored from the session without the flag", async () => {
    const s = session("s1");
    const first = await load({ session: s, flags: { "cataly-role": "lane" } });
    await first.emit("session_start");
    expect(s.entries).toEqual([wireRole("lane")]);

    // a later process resumes the same session file (`omp --resume`) without the flag
    calls.length = 0;
    const resumed = await load({ session: s });
    await resumed.emit("session_start");
    expect(s.entries).toEqual([wireRole("lane")]);
    expect(readPaneState(stateDir, PANE)?.role).toBe("lane");
    expect(await resumed.emit("before_agent_start", agentStart)).toContainEqual({
      systemPrompt: ["base prompt", ROLE_INVARIANTS.lane],
    });
  });

  test("a flagged role whose session start fails for another reason than a rejected bootstrap is still recorded", async () => {
    const s = session("tools-fail");
    const lane = await load({ session: s, flags: { "cataly-role": "lane" } });
    lane.api.setActiveTools = async () => {
      throw new Error("tool list unavailable");
    };
    await expect(lane.emit("session_start")).rejects.toThrow("tool list unavailable");
    // The process keeps the role it was started with, so a later resume without the flag must restore it too.
    expect(s.entries).toEqual([wireRole("lane")]);
  });

  test("a session without a role changes nothing and never sends a user message", async () => {
    const normal = await load({ session: session("plain") });
    await normal.emit("session_start");
    expect(await normal.emit("before_agent_start", agentStart)).toEqual([undefined]);

    expect(normal.userMessages).toEqual([]);
    expect(normal.notes).toEqual([]);
    expect(normal.session.entries).toEqual([]);
    expect(normal.active).toEqual(["read", "bash"]);
    expect(existsSync(paneStatePath(stateDir, PANE))).toBe(false);
    // approval hooks would make omp emit approval events and drop read speculation in every session
    expect(normal.handlers.has("tool_approval_requested")).toBe(false);
  });

  test("cataly -> normal -> cataly switching follows each session's role", async () => {
    const catalySession = session("cataly-1");
    const normalSession = session("plain-1");
    const pi = await load({ session: catalySession, flags: { "cataly-role": "cataly" } });
    await pi.emit("session_start");
    expect(pi.active).toContain("monitor");

    pi.session = normalSession;
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    expect(normalSession.entries).toEqual([]);
    expect(pi.active).not.toContain("monitor");
    expect(await pi.emit("before_agent_start", agentStart)).toEqual([undefined]);
    expect(existsSync(paneStatePath(stateDir, PANE))).toBe(false);

    pi.session = catalySession;
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    expect(pi.active).toContain("monitor");
    expect(readPaneState(stateDir, PANE)).toMatchObject({ role: "cataly", sessionId: "cataly-1" });
  });

  test("subagents inherit their parent's role; children of normal sessions stay plain", async () => {
    const parent = await load({ session: session("lane-parent"), flags: { "cataly-role": "lane" } });
    await parent.emit("session_start");
    const child = await load({
      session: session("child"),
      agent: { kind: "sub", id: "0-Explore", parentId: "Main" },
      active: ["read", "bash", "cataly_report"],
    });
    await child.emit("session_start");
    expect(await child.emit("before_agent_start", agentStart)).toEqual([undefined]);
    // grandchildren resolve through the child
    const grandchild = await load({
      session: session("grandchild"),
      agent: { kind: "sub", id: "0-Explore.1-Task", parentId: "0-Explore" },
    });
    await grandchild.emit("session_start");
    expect(await grandchild.emit("before_agent_start", agentStart)).toEqual([undefined]);
    // A child never owns the pane or the explicitly selected lane-only report tool.
    expect(readPaneState(stateDir, PANE)?.sessionId).toBe("lane-parent");
    expect(child.active).toEqual(["read", "bash"]);

    const plain = await load({ session: session("plain-parent") });
    await plain.emit("session_start");
    const plainChild = await load({
      session: session("plain-child"),
      agent: { kind: "sub", id: "1-Task", parentId: "Main" },
    });
    await plainChild.emit("session_start");
    expect(await plainChild.emit("before_agent_start", agentStart)).toEqual([undefined]);
  });
});

describe("goal tool", () => {
  test("is activated only for lanes that have no goal yet", async () => {
    const lane = await load({ session: session("lane"), flags: { "cataly-role": "lane" } });
    await lane.emit("session_start");
    expect(lane.active).toEqual(["read", "bash", "cataly_report", "goal"]);

    const goalEntry = {
      type: "mode_change",
      mode: "goal_paused",
      data: { goal: { objective: "ship it", status: "paused" } },
    };
    const laneWithGoal = await load({ session: session("lane-goal", [roleEntry("lane"), goalEntry]) });
    await laneWithGoal.emit("session_start");
    expect(laneWithGoal.active).toEqual(["read", "bash", "cataly_report"]);

    const cataly = await load({ session: session("cataly"), flags: { "cataly-role": "cataly" } });
    await cataly.emit("session_start");
    expect(cataly.active).toEqual(["read", "bash", "monitor"]);

    const normal = await load({ session: session("plain") });
    await normal.emit("session_start");
    expect(normal.active).toEqual(["read", "bash"]);
  });

  // A plain session is reached by switching to its file, never by creating one in this process (`reason: "new"`),
  // which keeps the process's own role.
  test("is taken back when a goal-less lane switches to a normal session", async () => {
    const pi = await load({ session: session("lane"), flags: { "cataly-role": "lane" } });
    await pi.emit("session_start");
    pi.session = session("plain");
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    expect(pi.active).toEqual(["read", "bash"]);
  });

  test("is taken back from a normal session even after the lane created its goal", async () => {
    const pi = await load({ session: session("lane"), flags: { "cataly-role": "lane" } });
    await pi.emit("session_start");
    await pi.emit("goal_updated", { type: "goal_updated", goal: { objective: "fix #12", status: "active" } });
    pi.session = session("plain");
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    expect(pi.active).toEqual(["read", "bash"]);
  });

  test("stays for a normal session whose own goal omp manages", async () => {
    const pi = await load({ session: session("lane"), flags: { "cataly-role": "lane" } });
    await pi.emit("session_start");
    const goalEntry = {
      type: "mode_change",
      mode: "goal",
      data: { goal: { objective: "own goal", status: "active" } },
    };
    pi.session = session("plain-goal", [goalEntry]);
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    expect(pi.active).toEqual(["read", "bash", "goal"]);
  });
});

describe("monitor restore", () => {
  const monitorCall = async (pi: FakePi, params: Record<string, unknown>): Promise<string> => {
    const result = await pi.tools.get("monitor")?.execute("call", params, undefined, undefined, pi.ctx());
    return result?.content[0]?.text ?? "";
  };
  const tick = { op: "start", name: "tick", argv: ["sh", "-c", "echo up; exec sleep 30"], filter: "^up" };

  test("a resumed Cataly session restarts the monitors it recorded and their lines wake it again", async () => {
    const s = session("cataly-r1");
    const first = await load({ session: s, flags: { "cataly-role": "cataly" } });
    await first.emit("session_start");
    await monitorCall(first, { ...tick, restart: "on-failure" });
    await first.emit("session_shutdown"); // omp exits: the monitor process dies with it

    // a restart resumes the pane with `omp --resume`: a new process, no flag, nobody asks for the monitor again
    const resumed = await load({ session: s });
    await resumed.emit("session_start");
    expect(resumed.messages[0]).toEqual({
      content: "[monitor] restored for this resumed session: tick",
      options: { triggerTurn: false },
    });
    await until(() => resumed.messages.some((m) => m.content === "[tick] up"));
    expect(await monitorCall(resumed, { op: "list" })).toContain("tick (pid");
    expect(s.entries.find((entry) => entry.customType === "omp-cataly:monitor")?.data).toMatchObject({
      op: "start",
      name: "tick",
      restart: "on-failure",
    });
    await resumed.emit("session_shutdown");
  });

  // POSIX-only: records the monitor metadata file's 0o600 mode bits.
  posix("a fresh Cataly session restores carried monitors from a native branch snapshot", async () => {
    const started = session("cataly-c1", [roleEntry("cataly")]);
    const fresh = session("cataly-c2");
    const pi = await load({ session: started, flags: { "cataly-role": "cataly" } });
    let resumed: FakePi | undefined;
    const pids: number[] = [];
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await pi.emit("session_start");
      await monitorCall(pi, tick);
      const initial = await monitorCall(pi, { op: "list" });
      expect(initial).toContain("tick (pid");
      const oldPid = Number(/pid (\d+)/.exec(initial)?.[1]);
      pids.push(oldPid);
      expect(alive(oldPid)).toBe(true);
      await until(() => pi.messages.some((m) => m.content === "[tick] up"));
      pi.messages.length = 0;

      pi.session = fresh;
      const snapshot = pi.ctx().sessionManager.getBranch();
      await pi.emit("session_switch", { type: "session_switch", reason: "new" });
      expect(snapshot).toEqual([]);
      expect(fresh.entries).toEqual([
        wireRole("cataly"),
        { type: "custom", customType: "omp-cataly:monitor", data: { ...tick, cwd: tmpdir(), id: expect.any(String) } },
      ]);
      expect(pi.active).toContain("monitor");
      expect(await pi.emit("before_agent_start", agentStart)).toContainEqual({
        systemPrompt: ["base prompt", ROLE_INVARIANTS.cataly],
      });
      const carried = await monitorCall(pi, { op: "list" });
      expect(carried).toContain("tick (pid");
      expect(carried.split("\n")).toHaveLength(1);
      const carriedPid = Number(/pid (\d+)/.exec(carried)?.[1]);
      pids.push(carriedPid);
      await until(() => !alive(oldPid));
      expect(alive(carriedPid)).toBe(true);
      await until(() => pi.messages.some((m) => m.content === "[tick] up"));
      expect(pi.messages.filter((m) => m.content === "[tick] up")).toEqual([
        { content: "[tick] up", options: { triggerTurn: true, deliverAs: "aside" } },
      ]);
      const metadata = join(stateDir, "monitors", `${fresh.id}.json`);
      expect(JSON.parse(readFileSync(metadata, "utf8"))).toEqual({
        version: 1,
        sessionId: fresh.id,
        monitors: [{ name: tick.name, argv: tick.argv, filter: tick.filter, cwd: tmpdir() }],
      });
      expect(lstatSync(metadata).mode & 0o777).toBe(0o600);
      expect(readPaneState(stateDir, PANE)).toMatchObject({ role: "cataly", sessionId: fresh.id });
      await pi.emit("session_shutdown");
      await until(() => pids.every((pid) => !alive(pid)));
      const stopped = await monitorCall(pi, { op: "list" });
      expect(stopped).toContain("tick [mode=persistent status=recorded]");
      expect(stopped).not.toContain("pid ");

      // A later process needs only the destination records, not the original role flag or monitor process.
      resumed = await load({ session: fresh });
      await resumed.emit("session_start");
      const restored = await monitorCall(resumed, { op: "list" });
      expect(restored).toContain("tick (pid");
      expect(restored.split("\n")).toHaveLength(1);
      pids.push(Number(/pid (\d+)/.exec(restored)?.[1]));
      const restoredSession = resumed;
      await until(() => restoredSession.messages.some((m) => m.content === "[tick] up"));
      expect(fresh.entries).toHaveLength(2);
      expect(resumed.active).toContain("monitor");
    } finally {
      await pi.emit("session_shutdown");
      await resumed?.emit("session_shutdown");
      await until(() => pids.every((pid) => !alive(pid)));
    }
  });

  test("a monitor stopped by name, even after it exited on its own, is not restored", async () => {
    const s = session("cataly-r2");
    const first = await load({ session: s, flags: { "cataly-role": "cataly" } });
    await first.emit("session_start");
    await monitorCall(first, { ...tick, name: "once", argv: ["sh", "-c", "echo up"] });
    await until(() => first.messages.some((m) => m.content.includes("[once] monitor exited")));
    expect(await monitorCall(first, { op: "stop", name: "once" })).toBe('stopped monitor "once"');
    await first.emit("session_shutdown");

    const resumed = await load({ session: s });
    await resumed.emit("session_start");
    expect(resumed.messages).toEqual([]);
    expect(await monitorCall(resumed, { op: "list" })).toBe("no monitors running or recorded");
  });

  test("only Cataly sessions restore monitors", async () => {
    const recorded = { type: "custom", customType: "omp-cataly:monitor", data: { ...tick, cwd: "/tmp" } };
    const lane = await load({ session: session("lane-r", [roleEntry("lane"), recorded]) });
    await lane.emit("session_start");
    const normal = await load({ session: session("plain-r", [recorded]) });
    await normal.emit("session_start");
    expect([...lane.messages, ...normal.messages]).toEqual([]);
  });
});

describe("pane state", () => {
  test("a nested run preserves the live owner's record and a later session can replace its dead record", async () => {
    const owner = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    try {
      const lead = await load({ session: session("lead"), flags: { "cataly-role": "cataly" } });
      await lead.emit("session_start");
      const owned = readPaneState(stateDir, PANE);
      if (owned === null) throw new Error("the lead session did not record its pane");
      expect(owned).toMatchObject({ pid: process.pid, sessionId: "lead", role: "cataly" });
      writePaneState(stateDir, { ...owned, pid: owner.pid });

      const nested = await load({ session: session("nested"), flags: { "cataly-role": "lane" } });
      await nested.emit("session_start");
      await nested.emit("goal_updated", { goal: { objective: "nested work", status: "active" } });
      expect(readPaneState(stateDir, PANE)).toEqual({ ...owned, pid: owner.pid });
      await nested.emit("session_shutdown");
      expect(readPaneState(stateDir, PANE)).toEqual({ ...owned, pid: owner.pid });

      owner.kill();
      await owner.exited;
      const replacement = await load({ session: session("replacement"), flags: { "cataly-role": "lane" } });
      await replacement.emit("session_start");
      expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: process.pid, sessionId: "replacement" });
      await replacement.emit("session_shutdown");
      expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: 0, sessionId: "replacement" });
      await lead.emit("session_shutdown");
    } finally {
      if (owner.exitCode === null) owner.kill();
      await owner.exited;
    }
  });

  // POSIX-only: PID reuse detection reads `ps` start time and the fixture owner is the Unix `sleep`.
  posix(
    "a live process reusing a stale record's pid does not block a new session from recording the pane",
    async () => {
      const unrelated = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
      try {
        writePaneState(stateDir, {
          paneId: PANE,
          role: "lane",
          sessionId: "stale",
          cwd: "/tmp",
          pid: unrelated.pid,
          startedAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
          goal: { status: "none" },
          approvalPending: false,
        });
        const fresh = await load({ session: session("fresh"), flags: { "cataly-role": "lane" } });
        await fresh.emit("session_start");
        await fresh.emit("agent_start");
        expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: process.pid, sessionId: "fresh" });
        await fresh.emit("session_shutdown");
        expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: 0, sessionId: "fresh" });
      } finally {
        unrelated.kill();
        await unrelated.exited;
      }
    },
  );

  test.each([0, undefined, "17", -1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "an invalid incumbent pid %j cannot wedge pane recording or cleanup",
    async (pid) => {
      const first = await load({ session: session("first"), flags: { "cataly-role": "lane" } });
      await first.emit("session_start");
      const owned = readPaneState(stateDir, PANE);
      if (owned === null) throw new Error("the first session did not record its pane");
      writeFileSync(paneStatePath(stateDir, PANE), JSON.stringify({ ...owned, pid }));

      const next = await load({ session: session("next"), flags: { "cataly-role": "lane" } });
      await next.emit("session_start");
      expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: process.pid, sessionId: "next" });
      await next.emit("goal_updated", { goal: { objective: "recover pane", status: "active" } });
      expect(readPaneState(stateDir, PANE)?.goal).toEqual({ objective: "recover pane", status: "active" });
      await next.emit("session_shutdown");
      expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: 0, sessionId: "next" });
      await first.emit("session_shutdown");
    },
  );

  test("records the session on start, goal updates and open approvals", async () => {
    const pi = await load({ session: session("lane-1"), flags: { "cataly-role": "lane" } });
    await pi.emit("session_start");
    expect(readPaneState(stateDir, PANE)).toMatchObject({
      paneId: PANE,
      role: "lane",
      sessionId: "lane-1",
      sessionFile: "/sessions/lane-1.jsonl",
      pid: process.pid,
      goal: { status: "none" },
      approvalPending: false,
    });
    const startedAt = readPaneState(stateDir, PANE)?.startedAt;

    await pi.emit("goal_updated", { type: "goal_updated", goal: { objective: "fix #12", status: "active" } });
    expect(readPaneState(stateDir, PANE)?.goal).toEqual({ status: "active", objective: "fix #12" });
    await pi.emit("goal_updated", { type: "goal_updated", goal: { objective: "fix #12", status: "paused" } });
    expect(readPaneState(stateDir, PANE)?.goal).toEqual({ status: "paused", objective: "fix #12" });
    await pi.emit("goal_updated", { type: "goal_updated", goal: { objective: "fix #12", status: "budget-limited" } });
    expect(readPaneState(stateDir, PANE)?.goal.status).toBe("blocked");

    await pi.emit("tool_approval_requested", {
      type: "tool_approval_requested",
      sessionId: pi.session.id,
      toolName: "bash",
      approvalMode: "always-ask",
      toolCallId: "a",
    });
    await pi.emit("tool_approval_requested", {
      type: "tool_approval_requested",
      sessionId: pi.session.id,
      toolName: "bash",
      approvalMode: "always-ask",
      toolCallId: "b",
    });
    expect(readPaneState(stateDir, PANE)?.approvalPending).toBe(true);
    await pi.emit("tool_approval_resolved", {
      type: "tool_approval_resolved",
      sessionId: pi.session.id,
      toolName: "bash",
      toolCallId: "a",
      approved: true,
    });
    expect(readPaneState(stateDir, PANE)?.approvalPending).toBe(true);
    await pi.emit("tool_approval_resolved", {
      type: "tool_approval_resolved",
      sessionId: pi.session.id,
      toolName: "bash",
      toolCallId: "b",
      approved: false,
    });
    expect(readPaneState(stateDir, PANE)).toMatchObject({ approvalPending: false, startedAt });
  });

  test.each([
    ["goal", "active", "active"],
    ["goal_paused", "paused", "paused"],
    ["goal_paused", "budget-limited", "blocked"],
    ["goal", "unknown-status", "blocked"],
    ["goal", "complete", "complete"],
    ["goal", "dropped", "dropped"],
  ] as const)("a resumed lane replays native %s goal status %s as %s", async (mode, status, expected) => {
    const goalEntry = {
      type: "mode_change",
      mode,
      data: { goal: { objective: "ship it", status } },
    };
    const entries = [roleEntry("lane"), goalEntry, { type: "custom", customType: "unrelated", data: "keep it" }];
    const pi = await load({ session: session("lane-2", entries) });
    await pi.emit("session_start");
    expect(readPaneState(stateDir, PANE)?.goal).toEqual({ status: expected, objective: "ship it" });
    pi.session = session("lane-resumed", entries);
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    expect(readPaneState(stateDir, PANE)?.goal).toEqual({ status: expected, objective: "ship it" });
    expect(entries[2]?.data).toBe("keep it");
  });

  test.each([
    { mode: "goal", data: undefined },
    { mode: "goal", data: null },
    { mode: "goal", data: "unstructured" },
    { mode: "goal", data: {} },
    { mode: "goal", data: { goal: { objective: "ship it" } } },
    { mode: "normal", data: { goal: { objective: "ship it", status: "active" } } },
  ])("a later native mode entry ends replayed goal state: %j", async (entry) => {
    const pi = await load({
      session: session("lane-ended", [
        roleEntry("lane"),
        { type: "mode_change", mode: "goal", data: { goal: { objective: "ship it", status: "active" } } },
        { type: "mode_change", ...entry },
      ]),
    });
    await pi.emit("session_start");
    expect(readPaneState(stateDir, PANE)?.goal).toEqual({ status: "none" });
    expect(pi.active).toEqual(["read", "bash", "cataly_report", "goal"]);
  });

  test("is retired to a pid-less tombstone at session shutdown, unless another process has taken the pane since", async () => {
    const pi = await load({ session: session("lane-4"), flags: { "cataly-role": "lane" } });
    await pi.emit("session_start");
    expect(existsSync(paneStatePath(stateDir, PANE))).toBe(true);
    await pi.emit("session_shutdown");
    // Keep the persisted session identity available for resume without claiming live ownership.
    expect(readPaneState(stateDir, PANE)).toMatchObject({
      pid: 0,
      sessionId: "lane-4",
      role: "lane",
      sessionFile: "/sessions/lane-4.jsonl",
      approvalPending: false,
      agentStatus: "idle",
    });

    const again = await load({ session: session("lane-5"), flags: { "cataly-role": "lane" } });
    await again.emit("session_start");
    const other = readPaneState(stateDir, PANE);
    if (!other) throw new Error("pane state missing");
    writePaneState(stateDir, { ...other, pid: process.pid + 1, sessionId: "other" });
    await again.emit("session_shutdown");
    expect(readPaneState(stateDir, PANE)?.sessionId).toBe("other");
  });

  test("headless sessions preserve a retired pane until an interactive plain session takes over", async () => {
    const lead = await load({ session: session("cataly-9"), flags: { "cataly-role": "cataly" } });
    await lead.emit("session_start");
    await lead.emit("session_shutdown");
    expect(readPaneState(stateDir, PANE)?.sessionId).toBe("cataly-9");

    for (const mode of ["print", "rpc"]) {
      const headless = await load({ session: session(`headless-${mode}`), mode });
      await headless.emit("session_start");
      expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: 0, sessionId: "cataly-9" });
      await headless.emit("session_shutdown");
      expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: 0, sessionId: "cataly-9" });
    }

    const plain = await load({ session: session("plain-9"), mode: "tui" });
    await plain.emit("session_start");
    expect(readPaneState(stateDir, PANE)).toBeNull();
    await plain.emit("session_shutdown");
    expect(readPaneState(stateDir, PANE)).toBeNull();
  });

  test("approvals in a normal session reached from a Cataly session leave no pane file", async () => {
    const pi = await load({ session: session("cataly-2"), flags: { "cataly-role": "cataly" } });
    await pi.emit("session_start");
    pi.session = session("plain-2");
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    await pi.emit("tool_approval_requested", {
      type: "tool_approval_requested",
      sessionId: pi.session.id,
      toolName: "bash",
      approvalMode: "always-ask",
      toolCallId: "a",
    });
    expect(existsSync(paneStatePath(stateDir, PANE))).toBe(false);
  });

  test("TERN_PANE names the pane and tracks approvals", async () => {
    const pi = await load({ session: session("tern-lane"), flags: { "cataly-role": "lane" } });
    await pi.emit("session_start");
    expect(readPaneState(stateDir, PANE)).toMatchObject({
      paneId: PANE,
      sessionId: "tern-lane",
      approvalPending: false,
    });
    await pi.emit("tool_approval_requested", {
      type: "tool_approval_requested",
      sessionId: pi.session.id,
      toolName: "bash",
      approvalMode: "always-ask",
      toolCallId: "tern-approval",
    });
    expect(readPaneState(stateDir, PANE)?.approvalPending).toBe(true);
    await pi.emit("session_shutdown");
    expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: 0, sessionId: "tern-lane" });
  });

  test("is not written without a runtime session id", async () => {
    delete process.env.TERN_PANE;
    const pi = await load({ session: session("lane-3"), flags: { "cataly-role": "lane" } });
    await pi.emit("session_start");
    expect(existsSync(join(stateDir, "sessions"))).toBe(false);
  });
});
