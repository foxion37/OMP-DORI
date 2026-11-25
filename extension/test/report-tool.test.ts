import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { evidenceClock } from "../../skills/cataly-mode/scripts/src/evidence.ts";
import { Registry } from "../../skills/cataly-mode/scripts/src/registry.ts";
import { Reports } from "../../skills/cataly-mode/scripts/src/reports.ts";
import { type Entry, type FakePi, load, useConfig } from "./fake-pi";

const HEADLESS = "00000000-0000-4000-8000-000000000005";
const KEY = "evidence-lane";
let stateDir: string;
beforeEach(async () => {
  stateDir = useConfig();
  process.env.CATALY_HEADLESS_ID = HEADLESS;
  await new Registry(stateDir).write({
    key: KEY,
    title: "evidence",
    thread: "none",
    sessionRef: { runtime: "headless", id: HEADLESS },
    brief: "/brief.md",
    done: "file /done.md",
    openedAt: "2026-01-01T00:00:00.000Z",
    reportProtocol: "jsonl-v1",
  });
});
afterEach(() => {
  delete process.env.CATALY_HEADLESS_ID;
});

const call = (id: string, name: string, args: Record<string, unknown>): Entry => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const result = (id: string, name: string, text: string, isError = false, details?: Record<string, unknown>): Entry => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError,
    details,
    timestamp: 1,
  },
});

const report = async (pi: FakePi, params: Record<string, unknown>, ctx = pi.ctx()): Promise<string> => {
  const tool = pi.tools.get("cataly_report");
  if (!tool) throw new Error("cataly_report is not registered");
  const out = await tool.execute("report-call", params, undefined, undefined, ctx);
  return out.content.map((block) => block.text).join("\n");
};

const lane = async (entries: Entry[]): Promise<FakePi> => {
  const pi = await load({
    session: { id: "lane-session", entries },
    flags: { "cataly-role": "lane" },
    mode: "rpc",
    hasUI: true,
  });
  await pi.emit("session_start");
  return pi;
};

test("cataly_report records file and tool evidence; the same evidence again is not new", async () => {
  const file = join(dirname(stateDir), "result.txt");
  writeFileSync(file, "first");
  const pi = await lane([
    call("c1", "bash", { command: "bun test" }),
    result("c1", "bash", "12 pass"),
    call("c2", "bash", { command: "bun test" }),
    result("c2", "bash", "12 pass\n\nWall time: 40.00 seconds", false, {
      wallTimeNoticeEmitted: true,
      wallTimeMs: 40_000,
    }),
  ]);
  for (const id of ["c1", "c2"]) await start(pi, id);
  const first = await report(pi, { kind: "milestone", text: "tests pass", files: [file], toolCalls: ["c1"] });
  expect(first).toBe(
    `[REPORT] ${KEY} | milestone | tests pass\n2 of 2 evidence items are new; the evidence clock moved`,
  );
  const reports = new Reports(stateDir);
  const clock = evidenceClock(reports.read(KEY)?.evidenced ?? []);
  expect(reports.read(KEY)?.lastReport?.evidenceRefs?.map((ref) => ref.kind)).toEqual(["file", "tool"]);

  // A rerun with the same result under a new call id and wall time, the same bytes, and new words: report clock only.
  const again = await report(pi, { kind: "milestone", text: "tests still pass", files: [file], toolCalls: ["c2"] });
  expect(again).toEndWith("the same evidence was recorded before; the evidence clock did not move");
  expect(await report(pi, { kind: "milestone", text: "no evidence" })).toEndWith(
    "no evidence attached; the evidence clock did not move",
  );
  expect(evidenceClock(reports.read(KEY)?.evidenced ?? [])).toEqual(clock);
  expect(reports.read(KEY)?.lastReport?.text).toBe("no evidence");

  writeFileSync(file, "second");
  expect(await report(pi, { kind: "milestone", text: "new result", files: [file] })).toEndWith(
    "1 of 1 evidence items are new; the evidence clock moved",
  );
});

test("a failed, missing or coordination call is refused and records nothing", async () => {
  const pi = await lane([
    call("failed", "bash", { command: "bun test" }),
    result("failed", "bash", "1 fail", true),
    call("chatter", "bash", { command: "cataly report evidence-lane --kind milestone --text x" }),
    result("chatter", "bash", "[REPORT] evidence-lane | milestone | x"),
  ]);
  for (const id of ["failed", "chatter", "not-on-branch"])
    await expect(report(pi, { kind: "milestone", text: "x", toolCalls: [id] })).rejects.toThrow("is not evidence");
  expect(existsSync(new Reports(stateDir).path(KEY))).toBe(false);
});

// Event shapes of OMP 18.20.0's agent loop and bash background job (src/tools/bash.ts report()); this file drives them
// through the fake API, native-tool-completion.test.ts through the native extension runner.
const frame = (state: string, jobId: string, text: string) => ({
  content: [{ type: "text", text }],
  details: { timeoutSeconds: 300, wallTimeMs: 9, wallTimeNoticeEmitted: false, async: { state, jobId, type: "bash" } },
});
const emitAs = async (pi: FakePi, event: string, payload: unknown, ctx = pi.ctx()): Promise<void> => {
  for (const handler of pi.handlers.get(event) ?? []) await handler(payload, ctx);
};
/** The agent loop starting call `id` while the session cwd is `cwd`. */
const start = (pi: FakePi, id: string, cwd = pi.ctx().cwd): Promise<void> =>
  emitAs(pi, "tool_execution_start", { toolCallId: id, toolName: "bash", args: {} }, { ...pi.ctx(), cwd });
/** A bash call that started job `jobId` in the background, returned, and is on the session's branch. */
const backgrounded = async (pi: FakePi, id: string, jobId: string): Promise<void> => {
  pi.session.entries.push(call(id, "bash", { command: "bun test", async: true }));
  await emitAs(pi, "tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: id,
    toolName: "bash",
    args: {},
  });
  const start = {
    content: [{ type: "text", text: `started ${jobId}` }],
    details: { async: { state: "running", jobId } },
  };
  await emitAs(pi, "tool_execution_end", { toolCallId: id, toolName: "bash", result: start, isError: false });
  pi.session.entries.push(result(id, "bash", `started ${jobId}`, false, start.details));
  await emitAs(pi, "tool_execution_update", {
    toolCallId: id,
    toolName: "bash",
    partialResult: frame("running", jobId, "1"),
  });
};
const settle = (pi: FakePi, id: string, jobId: string, state: string, text: string, ctx = pi.ctx()) =>
  emitAs(
    pi,
    "tool_execution_update",
    { toolCallId: id, toolName: "bash", partialResult: frame(state, jobId, text) },
    ctx,
  );
const receipts = (entries: Entry[]) => entries.filter((entry) => entry.customType === "omp-cataly:tool-completion");

test("a background call is evidence once its job completes, and a rerun with the same output is not new", async () => {
  const pi = await lane([]);
  await backgrounded(pi, "c1", "j1");
  expect(receipts(pi.session.entries)).toEqual([]);
  await expect(report(pi, { kind: "milestone", text: "x", toolCalls: ["c1"] })).rejects.toThrow("background");
  await settle(pi, "c1", "j1", "completed", "12 pass");
  await settle(pi, "c1", "j1", "completed", "12 pass");
  expect(receipts(pi.session.entries)).toHaveLength(1);
  expect(await report(pi, { kind: "milestone", text: "pass", toolCalls: ["c1"] })).toEndWith(
    "1 of 1 evidence items are new; the evidence clock moved",
  );
  await backgrounded(pi, "c2", "j2");
  await settle(pi, "c2", "j2", "completed", "12 pass");
  expect(await report(pi, { kind: "milestone", text: "again", toolCalls: ["c2"] })).toEndWith(
    "the same evidence was recorded before; the evidence clock did not move",
  );
  for (const state of ["failed", "cancelled"]) {
    await backgrounded(pi, state, `j-${state}`);
    await settle(pi, state, `j-${state}`, state, "boom");
    await expect(report(pi, { kind: "milestone", text: "x", toolCalls: [state] })).rejects.toThrow("is not evidence");
  }
  expect(receipts(pi.session.entries)).toHaveLength(2);
});

test("a late completion is not recorded in another session, branch or agent", async () => {
  const pi = await lane([]);
  await backgrounded(pi, "other-agent", "j1");
  await settle(pi, "other-agent", "j1", "completed", "x", { ...pi.ctx(), agent: { kind: "main", id: "Other" } });
  await backgrounded(pi, "moved", "j2");
  const original = pi.session;
  pi.session = { id: original.id, entries: original.entries.slice(0, -2) };
  await settle(pi, "moved", "j2", "completed", "x");
  pi.session = original;
  await backgrounded(pi, "new-session", "j3");
  pi.session = { id: "after-new", entries: [] };
  await settle(pi, "new-session", "j3", "completed", "x");
  expect([...receipts(original.entries), ...receipts(pi.session.entries)]).toEqual([]);
  pi.session = original;
  for (const id of ["other-agent", "moved", "new-session"])
    await expect(report(pi, { kind: "milestone", text: "x", toolCalls: [id] })).rejects.toThrow("background");
});

test("a command call is read in the session cwd it started in, never the cwd at report time", async () => {
  const scripts = join(import.meta.dir, "../../skills/cataly-mode/scripts");
  const checkpoint = { command: "bun src/cli.ts checkpoint evidence-lane --step s --result ok" };
  const output = '{"checkpoint":{"step":"s"}}';
  const pi = await lane([
    call("in-skill", "bash", checkpoint),
    result("in-skill", "bash", output),
    call("elsewhere", "bash", checkpoint),
    result("elsewhere", "bash", output),
    call("unseen", "bash", { command: "bun test" }),
    result("unseen", "bash", "12 pass"),
    call("twice", "bash", { command: "bun test" }),
    result("twice", "bash", "12 pass"),
  ]);
  await start(pi, "in-skill", scripts);
  await start(pi, "elsewhere", tmpdir());
  await start(pi, "twice", scripts);
  await start(pi, "twice", tmpdir());
  // After `/move`, the session cwd at report time differs from the one each call started in.
  const moved = { ...pi.ctx(), cwd: scripts };
  await expect(report(pi, { kind: "milestone", text: "x", toolCalls: ["in-skill"] })).rejects.toThrow("coordinates");
  for (const id of ["unseen", "twice"])
    await expect(report(pi, { kind: "milestone", text: "x", toolCalls: [id] }, moved)).rejects.toThrow("did not see");
  expect(existsSync(new Reports(stateDir).path(KEY))).toBe(false);
  expect(await report(pi, { kind: "milestone", text: "x", toolCalls: ["elsewhere"] }, moved)).toEndWith(
    "1 of 1 evidence items are new; the evidence clock moved",
  );
});

test("cataly_report runs only in a registered lane's main session", async () => {
  const pi = await lane([]);
  for (const agent of [
    { kind: "sub", id: "Sub", parentId: "Main" },
    { kind: "main", id: "Other" },
  ] as const)
    await expect(report(pi, { kind: "milestone", text: "x" }, { ...pi.ctx(), agent })).rejects.toThrow(
      "works only in a lane's main session",
    );
  process.env.CATALY_HEADLESS_ID = "00000000-0000-4000-8000-000000000009";
  await expect(report(pi, { kind: "milestone", text: "x" })).rejects.toThrow("no open lane is registered");
  process.env.CATALY_HEADLESS_ID = HEADLESS;
  const registry = new Registry(stateDir);
  const registered = await registry.read(KEY);
  if (!registered) throw new Error("evidence lane is not registered");
  const other = "other-evidence-lane";
  await registry.write({ ...registered, key: other });
  await expect(report(pi, { kind: "milestone", text: "x" })).rejects.toThrow(
    "no open lane is registered unambiguously",
  );
  expect(existsSync(new Reports(stateDir).path(other))).toBe(false);
  const cataly = await load({ session: { id: "cataly-session", entries: [] }, flags: { "cataly-role": "cataly" } });
  await cataly.emit("session_start");
  expect(cataly.active).not.toContain("cataly_report");
  await expect(report(cataly, { kind: "milestone", text: "x" })).rejects.toThrow("works only in a lane's main session");
  expect(existsSync(new Reports(stateDir).path(KEY))).toBe(false);
  await cataly.emit("session_shutdown");
});
