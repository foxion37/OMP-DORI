import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent";

import { readPaneState } from "../../skills/cataly-mode/scripts/src/lane-state";
import { type FakePi, load, useConfig } from "./fake-pi";

const PANE = "5071";
const T0 = Date.parse("2026-11-19T00:00:00Z");
const previousEnv = new Map<string, string | undefined>();
let stateDir: string;

beforeEach(() => {
  for (const key of ["CATALY_CONFIG", "CATALY_STATE_DIR", "TERN_PANE"]) previousEnv.set(key, process.env[key]);
  stateDir = useConfig();
  process.env.TERN_PANE = PANE;
});
afterEach(() => {
  setSystemTime();
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
});

type Item = AsyncJobSnapshot["running"][number];
const job = (id: string, startTime: number, status: Item["status"], endTime?: number): Item => ({
  id,
  type: "bash",
  status,
  label: `job ${id}`,
  intent: "build",
  startTime,
  ...(endTime === undefined ? {} : { endTime }),
  ownerId: "Main",
});
const snapshot = (running: Item[], recent: Item[] = []): AsyncJobSnapshot => ({
  running,
  recent,
  delivery: { queued: 0, delivering: false, pendingJobIds: [] },
});
const lane = (id = "lane-n"): Promise<FakePi> =>
  load({ session: { id, file: `/sessions/${id}.jsonl`, entries: [] }, flags: { "cataly-role": "lane" } });
const pane = () => readPaneState(stateDir, PANE);
const toolCall = (toolCallId: string) => ({ type: "tool_call", toolName: "bash", toolCallId, input: {} });
const requested = (sessionId: string, toolCallId: string, toolName = "bash") => ({
  type: "tool_approval_requested",
  sessionId,
  toolCallId,
  toolName,
  approvalMode: "always-ask",
});
const resolved = (sessionId: string, toolCallId: string, approved: boolean, toolName = "bash") => ({
  type: "tool_approval_resolved",
  sessionId,
  toolCallId,
  toolName,
  approved,
});

test("a session without a job manager records jobs as unobservable, with the time it was read", async () => {
  const pi = await lane();
  setSystemTime(new Date(T0));
  await pi.emit("session_start");
  expect(pane()?.native).toEqual({ observedAt: T0, jobs: null, approvals: [] });
});

test("the main session's snapshot is recorded as job identities and states only", async () => {
  const pi = await lane();
  pi.jobs = snapshot([job("bg_2", 200, "running")], [job("bg_1", 100, "completed", 150), job("bg_0", 50, "cancelled")]);
  await pi.emit("session_start");
  expect(pane()?.native?.jobs).toEqual({
    running: [{ id: "bg_2", startTime: 200 }],
    recent: [
      { id: "bg_1", startTime: 100, status: "completed", endTime: 150 },
      { id: "bg_0", startTime: 50, status: "cancelled" },
    ],
  });
});

test("a tool call records a changed job set before it runs and leaves an unchanged one as written", async () => {
  const pi = await lane();
  setSystemTime(new Date(T0));
  await pi.emit("session_start");
  pi.jobs = snapshot([job("bg_3", 300, "running")]);
  setSystemTime(new Date(T0 + 1_000));
  await pi.emit("tool_call", toolCall("c1"));
  const started = pane();
  expect(started?.native).toEqual({
    observedAt: T0 + 1_000,
    jobs: { running: [{ id: "bg_3", startTime: 300 }], recent: [] },
    approvals: [],
  });

  // Same jobs a second later: nothing is rewritten, so the record still names the read it holds.
  setSystemTime(new Date(T0 + 2_000));
  await pi.emit("tool_call", toolCall("c2"));
  expect(pane()).toEqual(started);

  pi.jobs = snapshot([], [job("bg_3", 300, "failed", 400)]);
  await pi.emit("tool_call", toolCall("c3"));
  expect(pane()?.native?.jobs).toEqual({
    running: [],
    recent: [{ id: "bg_3", startTime: 300, status: "failed", endTime: 400 }],
  });
});

test("a subagent's context or another session's context never replaces the main session's jobs", async () => {
  const pi = await lane();
  pi.jobs = snapshot([job("bg_main", 100, "running")]);
  await pi.emit("session_start");
  const main = pane()?.native;

  pi.agent = { kind: "sub", id: "Sub-1", parentId: "Main" };
  pi.jobs = snapshot([job("bg_sub", 300, "running")]);
  await pi.emit("tool_call", toolCall("sub-call"));
  expect(pane()?.native).toEqual(main);
  await pi.emit("tool_approval_requested", requested("sub-session", "sub-approval", "edit"));
  expect(pane()).toMatchObject({
    approvalPending: true,
    native: {
      observedAt: main?.observedAt,
      jobs: main?.jobs,
      approvals: [{ sessionId: "sub-session", toolCallId: "sub-approval", toolName: "edit" }],
    },
  });

  pi.agent = { kind: "main", id: "Main" };
  pi.session = { id: "not-current", entries: [] };
  await pi.emit("tool_call", toolCall("stale-call"));
  expect(pane()?.native?.jobs).toEqual(main?.jobs);
});

test("approvals carry their event's session; another session's event never resolves them", async () => {
  const pi = await lane("lane-n");
  await pi.emit("session_start");
  await pi.emit("tool_approval_requested", requested("lane-n", "call-1"));
  await pi.emit("tool_approval_requested", requested("sub-1", "call-1", "edit"));
  expect(pane()).toMatchObject({
    approvalPending: true,
    native: {
      approvals: [
        { sessionId: "lane-n", toolCallId: "call-1", toolName: "bash" },
        { sessionId: "sub-1", toolCallId: "call-1", toolName: "edit" },
      ],
    },
  });

  await pi.emit("tool_approval_resolved", resolved("sub-1", "call-1", true, "edit"));
  await pi.emit("tool_approval_resolved", resolved("other-session", "call-1", false));
  expect(pane()).toMatchObject({
    approvalPending: true,
    native: { approvals: [{ sessionId: "lane-n", toolCallId: "call-1", toolName: "bash" }] },
  });

  // A denial ends the approval exactly as an approval does; neither is recorded as permission.
  await pi.emit("tool_approval_resolved", resolved("lane-n", "call-1", false));
  expect(pane()).toMatchObject({ approvalPending: false, native: { approvals: [] } });
});

test("a session switch drops the previous session's approvals and jobs", async () => {
  const pi = await lane("lane-old");
  pi.jobs = snapshot([job("bg_1", 100, "running")]);
  await pi.emit("session_start");
  await pi.emit("tool_approval_requested", requested("lane-old", "call-old"));
  const old = pane();
  expect(old?.native?.approvals).toHaveLength(1);

  pi.jobs = null;
  pi.session = { id: "lane-new", file: "/sessions/lane-new.jsonl", entries: [] };
  setSystemTime(new Date(T0 + 5_000));
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  const fresh = pane();
  expect(fresh).toMatchObject({
    sessionId: "lane-new",
    startedAt: new Date(T0 + 5_000).toISOString(),
    approvalPending: false,
    native: { observedAt: T0 + 5_000, jobs: null, approvals: [] },
  });

  // The old session's late resolution changes nothing in the new one.
  await pi.emit("tool_approval_resolved", resolved("lane-old", "call-old", true));
  expect(pane()).toEqual(fresh);
});

test("the retired tombstone keeps the session's identity without its native observation", async () => {
  const pi = await lane("lane-r");
  pi.jobs = snapshot([job("bg_1", 100, "running")]);
  await pi.emit("session_start");
  expect(pane()?.native?.jobs?.running).toEqual([{ id: "bg_1", startTime: 100 }]);
  await pi.emit("session_shutdown");
  const retired = pane();
  expect(retired).toMatchObject({ pid: 0, sessionId: "lane-r", approvalPending: false });
  expect(retired).not.toHaveProperty("native");
});
