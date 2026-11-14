import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { paneStatePath, readPaneState, writePaneState } from "../../skills/dori-mode/scripts/src/lane-state";
import { type FakePi, type FakeSession, load, until, useConfig } from "./fake-pi";
import { calls } from "./fake-ulw";

const FAKE_ULW = join(import.meta.dir, "fake-ulw.ts");
const REAL_ULW = join(import.meta.dir, "../../ref/omp-ulw/index.ts");
const PANE = "w1:p2";
const ROLE = "omp-dori:role";

const session = (id: string, entries: FakeSession["entries"] = []): FakeSession => ({
  id,
  file: `/sessions/${id}.jsonl`,
  entries,
});
const roleEntry = (role: string) => ({ type: "custom", customType: ROLE, data: role });
const agentStart = { type: "before_agent_start", prompt: "ulw fix the bug", systemPrompt: ["base prompt"] };

let stateDir: string;
beforeEach(() => {
  calls.length = 0;
  stateDir = useConfig(FAKE_ULW);
  process.env.HERDR_PANE_ID = PANE;
  delete process.env.HC_TERMINAL_ID;
});
afterEach(() => {
  delete process.env.HERDR_PANE_ID;
  delete process.env.HC_TERMINAL_ID;
});

describe("role", () => {
  test("--dori-role is recorded on session start and restored from the session without the flag", async () => {
    const s = session("s1");
    const first = await load({ session: s, flags: { "dori-role": "lane" } });
    await first.emit("session_start");
    expect(s.entries).toEqual([roleEntry("lane")]);

    // a later process resumes the same session file (herdr restore, `omp --resume`) without the flag
    calls.length = 0;
    const resumed = await load({ session: s });
    await resumed.emit("session_start");
    expect(s.entries).toEqual([roleEntry("lane")]);
    expect(readPaneState(stateDir, PANE)?.role).toBe("lane");
    expect(await resumed.emit("before_agent_start", agentStart)).toContainEqual({
      systemPrompt: ["base prompt", "<fake-ulw-policy>"],
    });
  });

  test("a session without a role runs no omp-ulw handler and never sends a user message", async () => {
    const normal = await load({ session: session("plain") });
    await normal.emit("session_start");
    expect(await normal.emit("before_agent_start", agentStart)).toEqual([undefined]);
    await normal.command("ulw", "do it");
    const tool = normal.tools.get("fake_ulw_tool");
    const result = await tool?.execute("call-1", {}, undefined, undefined, normal.ctx());

    expect(calls).toEqual([]);
    expect(normal.userMessages).toEqual([]);
    expect(normal.notes).toEqual([
      "/ulw works only in Dori sessions (omp --dori-role dori|lane).",
      "fake_ulw_tool works only in Dori sessions (omp --dori-role dori|lane).",
    ]);
    expect(result?.content[0]?.text).toContain("works only in Dori sessions");
    expect(normal.session.entries).toEqual([]);
    expect(normal.active).toEqual(["read", "bash"]);
    expect(existsSync(paneStatePath(stateDir, PANE))).toBe(false);
    // approval hooks would make omp emit approval events and drop read speculation in every session
    expect(normal.handlers.has("tool_approval_requested")).toBe(false);
  });

  test("dori -> normal -> dori switching follows each session's role", async () => {
    const doriSession = session("dori-1");
    const normalSession = session("plain-1");
    const pi = await load({ session: doriSession, flags: { "dori-role": "dori" } });
    await pi.emit("session_start");
    expect(pi.active).toContain("monitor");
    await pi.command("ulw", "x");
    expect(pi.userMessages).toEqual(["ulw x"]);

    pi.session = normalSession;
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    expect(normalSession.entries).toEqual([]);
    expect(pi.active).not.toContain("monitor");
    expect(await pi.emit("before_agent_start", agentStart)).toEqual([undefined]);
    await pi.command("ulw", "y");
    expect(pi.userMessages).toEqual(["ulw x"]);
    expect(existsSync(paneStatePath(stateDir, PANE))).toBe(false);

    calls.length = 0;
    pi.session = doriSession;
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    expect(calls).toEqual(["restore:dori-1"]);
    expect(pi.active).toContain("monitor");
    expect(readPaneState(stateDir, PANE)).toMatchObject({ role: "dori", sessionId: "dori-1" });
    await pi.command("ulw", "z");
    expect(pi.userMessages).toEqual(["ulw x", "ulw z"]);
  });

  test("subagents inherit their parent's role; children of normal sessions stay plain", async () => {
    const parent = await load({ session: session("lane-parent"), flags: { "dori-role": "lane" } });
    await parent.emit("session_start");
    const child = await load({ session: session("child"), agent: { kind: "sub", id: "0-Explore", parentId: "Main" } });
    await child.emit("session_start");
    expect(await child.emit("before_agent_start", agentStart)).toContainEqual({
      systemPrompt: ["base prompt", "<fake-ulw-policy>"],
    });
    // grandchildren resolve through the child
    const grandchild = await load({
      session: session("grandchild"),
      agent: { kind: "sub", id: "0-Explore.1-Task", parentId: "0-Explore" },
    });
    await grandchild.emit("session_start");
    expect(await grandchild.emit("before_agent_start", agentStart)).toContainEqual({
      systemPrompt: ["base prompt", "<fake-ulw-policy>"],
    });
    // children never touch the pane file or the tool set
    expect(readPaneState(stateDir, PANE)?.sessionId).toBe("lane-parent");
    expect(child.active).toEqual(["read", "bash"]);

    const plain = await load({ session: session("plain-parent") });
    await plain.emit("session_start");
    calls.length = 0;
    const plainChild = await load({
      session: session("plain-child"),
      agent: { kind: "sub", id: "1-Task", parentId: "Main" },
    });
    await plainChild.emit("session_start");
    expect(await plainChild.emit("before_agent_start", agentStart)).toEqual([undefined]);
    expect(calls).toEqual([]);
  });

  test("omp-ulw that fails to load warns in role sessions only", async () => {
    stateDir = useConfig("/nonexistent/omp-ulw/index.ts");
    const normal = await load({ session: session("plain") });
    await normal.emit("session_start");
    expect(normal.notes).toEqual([]);

    const lane = await load({ session: session("lane"), flags: { "dori-role": "lane" } });
    await lane.emit("session_start");
    await lane.emit("session_switch", { type: "session_switch", reason: "resume" });
    expect(lane.notes).toHaveLength(1);
    expect(lane.notes[0]).toContain("omp-ulw not loaded from /nonexistent/omp-ulw/index.ts");
    expect(readPaneState(stateDir, PANE)?.role).toBe("lane");
  });

  test("an empty ompUlwPath leaves omp-ulw to a standalone extension: nothing is imported and nothing warns", async () => {
    stateDir = useConfig("");
    const lane = await load({ session: session("lane"), flags: { "dori-role": "lane" } });
    await lane.emit("session_start");
    expect(await lane.emit("before_agent_start", agentStart)).toEqual([undefined]);
    expect(lane.tools.has("fake_ulw_tool")).toBe(false);
    expect(lane.notes).toEqual([]);
    expect(readPaneState(stateDir, PANE)?.role).toBe("lane");
  });
});

describe("goal tool", () => {
  test("is activated only for lanes that have no goal yet", async () => {
    const lane = await load({ session: session("lane"), flags: { "dori-role": "lane" } });
    await lane.emit("session_start");
    expect(lane.active).toEqual(["read", "bash", "goal"]);

    const goalEntry = {
      type: "mode_change",
      mode: "goal_paused",
      data: { goal: { objective: "ship it", status: "paused" } },
    };
    const laneWithGoal = await load({ session: session("lane-goal", [roleEntry("lane"), goalEntry]) });
    await laneWithGoal.emit("session_start");
    expect(laneWithGoal.active).toEqual(["read", "bash"]);

    const dori = await load({ session: session("dori"), flags: { "dori-role": "dori" } });
    await dori.emit("session_start");
    expect(dori.active).toEqual(["read", "bash", "monitor"]);

    const normal = await load({ session: session("plain") });
    await normal.emit("session_start");
    expect(normal.active).toEqual(["read", "bash"]);
  });

  test("is taken back when a goal-less lane switches to a normal session", async () => {
    const pi = await load({ session: session("lane"), flags: { "dori-role": "lane" } });
    await pi.emit("session_start");
    pi.session = session("plain");
    await pi.emit("session_switch", { type: "session_switch", reason: "new" });
    expect(pi.active).toEqual(["read", "bash"]);
  });

  test("is taken back from a normal session even after the lane created its goal", async () => {
    const pi = await load({ session: session("lane"), flags: { "dori-role": "lane" } });
    await pi.emit("session_start");
    await pi.emit("goal_updated", { type: "goal_updated", goal: { objective: "fix #12", status: "active" } });
    pi.session = session("plain");
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    expect(pi.active).toEqual(["read", "bash"]);
  });

  test("stays for a normal session whose own goal omp manages", async () => {
    const pi = await load({ session: session("lane"), flags: { "dori-role": "lane" } });
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
  const tick = { op: "start", name: "tick", argv: ["sh", "-c", "echo up; sleep 30"], filter: "^up" };

  test("a resumed Dori session restarts the monitors it recorded and their lines wake it again", async () => {
    const s = session("dori-r1");
    const first = await load({ session: s, flags: { "dori-role": "dori" } });
    await first.emit("session_start");
    await monitorCall(first, tick);
    await first.emit("session_shutdown"); // omp exits: the monitor process dies with it

    // herdr restores the pane with `omp --resume`: a new process, no flag, nobody asks for the monitor again
    const resumed = await load({ session: s });
    await resumed.emit("session_start");
    expect(resumed.messages[0]).toEqual({
      content: "[monitor] restored for this resumed session: tick",
      options: { triggerTurn: false },
    });
    await until(() => resumed.messages.some((m) => m.content === "[tick] up"));
    expect(await monitorCall(resumed, { op: "list" })).toContain("tick (pid");
    await resumed.emit("session_shutdown");
  });

  test("a monitor stopped by name, even after it exited on its own, is not restored", async () => {
    const s = session("dori-r2");
    const first = await load({ session: s, flags: { "dori-role": "dori" } });
    await first.emit("session_start");
    await monitorCall(first, { ...tick, name: "once", argv: ["sh", "-c", "echo up"] });
    await until(() => first.messages.some((m) => m.content.includes("[once] monitor exited")));
    expect(await monitorCall(first, { op: "stop", name: "once" })).toBe('stopped monitor "once"');
    await first.emit("session_shutdown");

    const resumed = await load({ session: s });
    await resumed.emit("session_start");
    expect(resumed.messages).toEqual([]);
    expect(await monitorCall(resumed, { op: "list" })).toBe("no monitors running");
  });

  test("only Dori sessions restore monitors", async () => {
    const recorded = { type: "custom", customType: "omp-dori:monitor", data: { ...tick, cwd: "/tmp" } };
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
      const lead = await load({ session: session("lead"), flags: { "dori-role": "dori" } });
      await lead.emit("session_start");
      const owned = readPaneState(stateDir, PANE);
      if (owned === null) throw new Error("the lead session did not record its pane");
      expect(owned).toMatchObject({ pid: process.pid, sessionId: "lead", role: "dori" });
      writePaneState(stateDir, { ...owned, pid: owner.pid });

      const nested = await load({ session: session("nested"), flags: { "dori-role": "lane" } });
      await nested.emit("session_start");
      await nested.emit("goal_updated", { goal: { objective: "nested work", status: "active" } });
      expect(readPaneState(stateDir, PANE)).toEqual({ ...owned, pid: owner.pid });
      await nested.emit("session_shutdown");
      expect(readPaneState(stateDir, PANE)).toEqual({ ...owned, pid: owner.pid });

      owner.kill();
      await owner.exited;
      const replacement = await load({ session: session("replacement"), flags: { "dori-role": "lane" } });
      await replacement.emit("session_start");
      expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: process.pid, sessionId: "replacement" });
      await replacement.emit("session_shutdown");
      expect(readPaneState(stateDir, PANE)).toBeNull();
      await lead.emit("session_shutdown");
    } finally {
      if (owner.exitCode === null) owner.kill();
      await owner.exited;
    }
  });

  test.each([0, undefined, "17", -1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "an invalid incumbent pid %j cannot wedge pane recording or cleanup",
    async (pid) => {
      const first = await load({ session: session("first"), flags: { "dori-role": "lane" } });
      await first.emit("session_start");
      const owned = readPaneState(stateDir, PANE);
      if (owned === null) throw new Error("the first session did not record its pane");
      writeFileSync(paneStatePath(stateDir, PANE), JSON.stringify({ ...owned, pid }));

      const next = await load({ session: session("next"), flags: { "dori-role": "lane" } });
      await next.emit("session_start");
      expect(readPaneState(stateDir, PANE)).toMatchObject({ pid: process.pid, sessionId: "next" });
      await next.emit("goal_updated", { goal: { objective: "recover pane", status: "active" } });
      expect(readPaneState(stateDir, PANE)?.goal).toEqual({ objective: "recover pane", status: "active" });
      await next.emit("session_shutdown");
      expect(readPaneState(stateDir, PANE)).toBeNull();
      await first.emit("session_shutdown");
    },
  );

  test("records the session on start, goal updates and open approvals", async () => {
    const pi = await load({ session: session("lane-1"), flags: { "dori-role": "lane" } });
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

    await pi.emit("tool_approval_requested", { type: "tool_approval_requested", toolCallId: "a" });
    await pi.emit("tool_approval_requested", { type: "tool_approval_requested", toolCallId: "b" });
    expect(readPaneState(stateDir, PANE)?.approvalPending).toBe(true);
    await pi.emit("tool_approval_resolved", { type: "tool_approval_resolved", toolCallId: "a", approved: true });
    expect(readPaneState(stateDir, PANE)?.approvalPending).toBe(true);
    await pi.emit("tool_approval_resolved", { type: "tool_approval_resolved", toolCallId: "b", approved: false });
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
    expect(pi.active).toEqual(["read", "bash", "goal"]);
  });

  test("is removed at session shutdown, unless another process has taken the pane since", async () => {
    const pi = await load({ session: session("lane-4"), flags: { "dori-role": "lane" } });
    await pi.emit("session_start");
    expect(existsSync(paneStatePath(stateDir, PANE))).toBe(true);
    await pi.emit("session_shutdown");
    expect(existsSync(paneStatePath(stateDir, PANE))).toBe(false);

    const again = await load({ session: session("lane-5"), flags: { "dori-role": "lane" } });
    await again.emit("session_start");
    const other = readPaneState(stateDir, PANE);
    if (!other) throw new Error("pane state missing");
    writePaneState(stateDir, { ...other, pid: process.pid + 1, sessionId: "other" });
    await again.emit("session_shutdown");
    expect(readPaneState(stateDir, PANE)?.sessionId).toBe("other");
  });

  test("approvals in a normal session reached from a Dori session leave no pane file", async () => {
    const pi = await load({ session: session("dori-2"), flags: { "dori-role": "dori" } });
    await pi.emit("session_start");
    pi.session = session("plain-2");
    await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
    await pi.emit("tool_approval_requested", { type: "tool_approval_requested", toolCallId: "a" });
    expect(existsSync(paneStatePath(stateDir, PANE))).toBe(false);
  });

  test("hc uses its terminal id even when an inherited herdr pane id is present", async () => {
    process.env.HC_TERMINAL_ID = "t1b";
    const pi = await load({ session: session("hc-lane"), flags: { "dori-role": "lane" } });
    await pi.emit("session_start");
    expect(readPaneState(stateDir, "t1b")).toMatchObject({
      paneId: "t1b",
      sessionId: "hc-lane",
      approvalPending: false,
    });
    expect(readPaneState(stateDir, PANE)).toBeNull();
    await pi.emit("tool_approval_requested", { type: "tool_approval_requested", toolCallId: "hc-approval" });
    expect(readPaneState(stateDir, "t1b")?.approvalPending).toBe(true);
    await pi.emit("goal_updated", { type: "goal_updated", goal: { objective: "hc port", status: "paused" } });
    expect(readPaneState(stateDir, "t1b")?.goal.status).toBe("paused");
    await pi.emit("session_shutdown");
    expect(readPaneState(stateDir, "t1b")).toBeNull();
  });

  test("is not written without a runtime session id", async () => {
    delete process.env.HERDR_PANE_ID;
    const pi = await load({ session: session("lane-3"), flags: { "dori-role": "lane" } });
    await pi.emit("session_start");
    expect(existsSync(join(stateDir, "sessions"))).toBe(false);
  });
});

describe("context reporting", () => {
  test("a lane's pane state carries its model and context use, rewritten on turn end only when they change", async () => {
    const lane = await load({ session: session("ctx"), flags: { "dori-role": "lane" } });
    lane.model = { provider: "kiro-dori", id: "claude-haiku-5.5" };
    await lane.emit("session_start");
    expect(readPaneState(stateDir, PANE)?.model).toBe("kiro-dori/claude-haiku-5.5");
    expect(readPaneState(stateDir, PANE)?.context).toBeUndefined();

    lane.usage = { tokens: 41_234, contextWindow: 100_000, percent: 41.234 };
    await lane.emit("turn_end");
    const written = readPaneState(stateDir, PANE);
    expect(written?.context).toEqual({ percent: 41.2, tokens: 41_234, window: 100_000 });

    // an unchanged turn leaves the file alone: a marker stamped onto it survives
    if (written) writePaneState(stateDir, { ...written, updatedAt: "marker" });
    await lane.emit("turn_end");
    expect(readPaneState(stateDir, PANE)?.updatedAt).toBe("marker");
  });

  test("a lane session is named from DORI_LANE_LABEL, once per session", async () => {
    process.env.DORI_LANE_LABEL = "TLGR : 정리";
    try {
      const lane = await load({ session: session("named"), flags: { "dori-role": "lane" } });
      await lane.emit("session_start");
      expect(lane.sessionNames).toEqual(["TLGR : 정리"]);
      await lane.emit("session_start");
      expect(lane.sessionNames).toEqual(["TLGR : 정리"]);

      delete process.env.DORI_LANE_LABEL;
      const plain = await load({ session: session("unnamed"), flags: { "dori-role": "lane" } });
      await plain.emit("session_start");
      expect(plain.sessionNames).toEqual([]);
    } finally {
      delete process.env.DORI_LANE_LABEL;
    }
  });
});

describe.skipIf(!existsSync(REAL_ULW))("with the real omp-ulw", () => {
  test("normal sessions get no ULW and /ulw sends nothing; lanes get the ULW policy", async () => {
    useConfig(REAL_ULW);
    const normal = await load({ session: session("plain") });
    await normal.emit("session_start");
    await normal.command("ulw", "fix it");
    expect(normal.userMessages).toEqual([]);
    expect((await normal.emit("before_agent_start", agentStart)).filter(Boolean)).toEqual([]);
    expect(normal.session.entries).toEqual([]);

    const lane = await load({ session: session("lane"), flags: { "dori-role": "lane" } });
    await lane.emit("session_start");
    const results = await lane.emit("before_agent_start", agentStart);
    expect(JSON.stringify(results)).toContain("<omp-ulw-policy>");
    await lane.command("ulw", "fix it");
    expect(lane.userMessages).toEqual(["ulw fix it"]);
  });

  test("native OMP composes Sol bookkeeping with the pinned preset and preserves excluded prompts", async () => {
    if (!process.env["DORI_TEST_OMP_ROOT"])
      throw new Error("the real d69 fixture requires the exact native OMP host fixture; see CONTRIBUTING.md");
    const compat = process.env["DORI_TEST_COMPAT_ULW_ENTRY"];
    if (!compat || !isAbsolute(compat))
      throw new Error("the real d69 fixture also requires an absolute exact explicit-override fixture entry");
    // Fixture-free runs keep the existing skips; load this isolated SDK only inside the real-dependency guard.
    const { nativeComposition, SOL_MODEL } = await import("../../test/fixtures/omp-native-host/compose.ts");
    const dori = join(import.meta.dir, "../index.ts");
    const host = "intro\n⁂ Role\nHOST_ROLE\n⁂ Runtime\nrt\n⁂ Tool Policy\npolicy\n⁂ Workflow\nwf";
    const parent = { kind: "main", id: "NativeParent", name: "Main", depth: 0 } as const;
    for (const { embedded, entries } of [
      { embedded: true, entries: [dori] },
      { embedded: false, entries: [dori, REAL_ULW] },
      { embedded: false, entries: [REAL_ULW, dori] },
    ]) {
      useConfig(embedded ? REAL_ULW : "");
      const base = [host, "Retained downstream context"];
      const original = [...base];
      const result = await nativeComposition(entries, base, { role: "lane", agent: parent });
      if (!Array.isArray(result.first)) throw new Error("native OMP returned no combined prompt array");
      expect(result.first).toBeArray();
      expect(result.first).toEqual(result.afterAll[0]);
      expect(result.second).toEqual(result.first);
      expect(result.afterAll[1]).toEqual(result.first);
      expect(base).toEqual(original);
      const prompt = JSON.stringify(result.first);
      expect(prompt.match(/<omp-model-preset>/g)).toHaveLength(1);
      expect(prompt.match(/<omp-dori-lane-bookkeeping>/g)).toHaveLength(1);
      expect(prompt).not.toContain("HOST_ROLE");
      expect(prompt).toContain("Retained downstream context");
    }
    const exclusions = [
      { role: "dori" as const },
      {},
      { role: "lane" as const, model: { ...SOL_MODEL, id: "gpt-6.1-terra", name: "GPT-6.1 Terra" } },
      {
        role: "lane" as const,
        agent: { kind: "sub" as const, id: "NativeSub", name: "Sub", depth: 1, parentId: parent.id },
      },
    ];
    for (const excluded of exclusions) {
      useConfig("");
      const base = [host, "Retained downstream context"];
      const original = [...base];
      const result = await nativeComposition([REAL_ULW, dori], base, { ...excluded, observeBefore: dori });
      expect(result.beforeDori).toHaveLength(2);
      expect(result.afterAll).toEqual(result.beforeDori);
      expect(result.second).toEqual(result.first);
      if (result.first !== undefined) expect(result.first).toEqual(result.afterAll[0]);
      expect(JSON.stringify(result.afterAll)).not.toContain("<omp-dori-lane-bookkeeping>");
      expect(base).toEqual(original);
    }
    // Legacy explicit imports are compared as opaque baseline data, without assuming current preset markers.
    useConfig("");
    const legacyBase = [host, "Retained downstream context"];
    const original = [...legacyBase];
    const legacy = await nativeComposition([compat], legacyBase, { role: "lane", agent: parent });
    expect(legacy.second).toEqual(legacy.first);
    if (legacy.first !== undefined) expect(legacy.first).toEqual(legacy.afterAll[0]);
    expect(legacy.afterAll[1]).toEqual(legacy.afterAll[0]);
    expect(legacyBase).toEqual(original);
    useConfig(compat);
    const embedded = await nativeComposition([dori], legacyBase, { role: "lane", agent: parent });
    if (!embedded.first) throw new Error("embedded explicit override returned no native prompt");
    const legacyPrompt = legacy.afterAll[0];
    if (!legacyPrompt) throw new Error("the native runner did not observe the legacy baseline prompt");
    expect(embedded.first).toEqual(embedded.afterAll[0]);
    expect(embedded.second).toEqual(embedded.first);
    expect(embedded.afterAll[1]).toEqual(embedded.first);
    expect(legacyBase).toEqual(original);
    expect(JSON.stringify(legacyPrompt)).not.toContain("<omp-dori-lane-bookkeeping>");
    expect(JSON.stringify(embedded.first).match(/<omp-dori-lane-bookkeeping>/g)).toHaveLength(1);
    expect(embedded.first.filter((block) => block.includes("<omp-dori-lane-bookkeeping>"))).toHaveLength(1);
    expect(embedded.first.filter((block) => !block.includes("<omp-dori-lane-bookkeeping>"))).toEqual(legacyPrompt);
    for (const excluded of exclusions) {
      const base = [host, "Retained downstream context"];
      const before = [...base];
      useConfig("");
      // Outside a role, the explicit dependency was already gated off; the applicable baseline is the bare host.
      const baseline = await nativeComposition("role" in excluded ? [compat] : [], base, excluded);
      expect(baseline.second).toEqual(baseline.first);
      expect(base).toEqual(before);
      useConfig(compat);
      const result = await nativeComposition([dori], base, excluded);
      expect(result.first).toEqual(baseline.first);
      expect(result.second).toEqual(result.first);
      expect(result.afterAll).toEqual(baseline.afterAll);
      expect(JSON.stringify(result.afterAll)).not.toContain("<omp-dori-lane-bookkeeping>");
      expect(base).toEqual(before);
    }
  }, 30_000);
});
