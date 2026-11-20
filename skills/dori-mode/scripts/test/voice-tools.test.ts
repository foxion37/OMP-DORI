import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Discord } from "../src/messenger/discord.ts";
import type { HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { VoiceSettings } from "../src/voice/settings.ts";
import { voiceTools } from "../src/voice/tools.ts";
import type { VoiceTool } from "../src/voice/types.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const NOTES = "123456789012345678";
const settings = { textChannelId: NOTES } as VoiceSettings;

let state: TestState;
let world: World;
let requests: HttpRequest[];
let reply: HttpResponse;
let tool: VoiceTool;

const lane = (key: string, pane: string, at: string): Lane => ({
  key,
  title: key,
  thread: `thread-${key}`,
  sessionRef: { runtime: "herdr", id: pane, group: "w1" },
  pane,
  brief: "brief",
  done: "pr:o/r#1",
  openedAt: at,
  history: [{ at, status: "working", note: "launched" }],
});

beforeEach(() => {
  state = withState();
  world = newWorld();
  requests = [];
  reply = { status: 200, headers: {}, body: '{"id":"900"}' };
  const clock = fakeClock(T0);
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return reply;
  };
  tool = voiceTools(depsFor(world, clock, state.dir, { leadPane: "w1:p1" }), new Discord(http, clock, "t"), settings);
});
afterEach(() => state.done());

test("get_status reads lanes and reports in one call, each part with its own timestamps, and writes nothing", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write(lane("api-fix", "w1:p2", "2026-01-01T10:00:00.000Z"));
  await deps.registry.write(lane("docs-sync", "w1:p3", "2026-01-01T09:00:00.000Z"));
  world.panes = [
    { pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "idle" },
    { pane_id: "w1:p2", workspace_id: "w1", agent: "omp", agent_status: "working" },
  ];
  const reports = new Reports(state.dir);
  reports.report("docs-sync", "milestone", "docs drafted", Date.parse("2026-01-01T11:00:00.000Z"));
  reports.report("api-fix", "blocker", "needs a token\u001b[31m", Date.parse("2026-01-01T11:30:00.000Z"));
  const registryBefore = readFileSync(join(state.dir, "lanes", "api-fix.json"), "utf8");

  const r = await tool("get_status", { what: ["lanes", "reports"], speak_now: true });

  expect(r.ok).toBe(true);
  expect(Object.keys(r.parts ?? {})).toEqual(["lanes", "reports"]);
  const lanes = r.parts?.["lanes"]?.result ?? "";
  expect(lanes).toStartWith("read at 2026-01-01T12:00:00.000Z\n");
  expect(lanes).toContain("- api-fix working since 2026-01-01T10:00:00.000Z pane=w1:p2 thread=thread-api-fix");
  expect(lanes).toContain("docs-sync: pane w1:p3 is gone");
  expect(lanes).not.toContain("w1:p1");
  const reportLines = (r.parts?.["reports"]?.result ?? "").split("\n");
  expect(reportLines).toEqual([
    "read at 2026-01-01T12:00:00.000Z",
    "- 2026-01-01T11:30:00.000Z [REPORT] api-fix | blocker | needs a token (blocked)",
    "- 2026-01-01T11:00:00.000Z [REPORT] docs-sync | milestone | docs drafted (running)",
  ]);
  expect(r.result).toBe(`[lanes] ${lanes}\n[reports] ${reportLines.join("\n")}`);
  expect(readFileSync(join(state.dir, "lanes", "api-fix.json"), "utf8")).toBe(registryBefore);
  expect(world.calls.some((c) => c[2] === "send-text" || c[2] === "send-keys")).toBe(false);
  expect(requests).toHaveLength(0);
});

test("get_status names a damaged journal without failing the others, and accepts streamed JSON arguments", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write(lane("good-lane", "w1:p2", "2026-01-01T10:00:00.000Z"));
  await deps.registry.write(lane("bad-lane", "w1:p3", "2026-01-01T10:00:00.000Z"));
  new Reports(state.dir).report("good-lane", "done", "merged", Date.parse("2026-01-01T11:00:00.000Z"));
  mkdirSync(join(state.dir, "lanes", "bad-lane"), { recursive: true });
  writeFileSync(join(state.dir, "lanes", "bad-lane", "reports.jsonl"), "{not json\n");

  const r = await tool("get_status", JSON.stringify({ what: ["reports", "reports"], speak_now: false }));

  expect(r.ok).toBe(true);
  expect(Object.keys(r.parts ?? {})).toEqual(["reports"]);
  expect(r.result).toContain("- 2026-01-01T11:00:00.000Z [REPORT] good-lane | done | merged (done)");
  expect(r.result).toContain("unreadable journals: bad-lane");
});

test("get_status with no reports says so", async () => {
  const r = await tool("get_status", { what: ["reports"], speak_now: false });
  expect(r).toEqual({
    ok: true,
    result: "[reports] read at 2026-01-01T12:00:00.000Z\nno lane reports",
    parts: { reports: { ok: true, result: "read at 2026-01-01T12:00:00.000Z\nno lane reports" } },
  });
});

for (const args of [
  { what: ["beta"], speak_now: false },
  { what: [], speak_now: false },
  { what: ["lanes"] },
  { what: "lanes", speak_now: true },
  null,
])
  test(`get_status rejects ${JSON.stringify(args)} without reading anything`, async () => {
    const r = await tool("get_status", args);
    expect(r.ok).toBe(false);
    expect(r.result).toStartWith("invalid get_status arguments");
    expect(world.calls).toHaveLength(0);
  });

test("post_note posts one trimmed note to the configured text channel with mentions disabled", async () => {
  const r = await tool("post_note", { text: "  우유 사기\n두부 @everyone\u0007  " });
  expect(r).toEqual({ ok: true, result: "posted: the note is in the owner's Discord text channel" });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.url).toEndWith(`/channels/${NOTES}/messages`);
  expect(JSON.parse(String(requests[0]?.body))).toEqual({
    content: "Voice note: 우유 사기\n두부 @everyone",
    allowed_mentions: { parse: [] },
  });
});

test("post_note keeps a long note under Discord's message limit", async () => {
  expect((await tool("post_note", { text: "가".repeat(5000) })).ok).toBe(true);
  const body: unknown = JSON.parse(String(requests[0]?.body));
  const content = typeof body === "object" && body !== null && "content" in body ? String(body.content) : "";
  expect([...content].length).toBeLessThanOrEqual(1800 + "Voice note: ".length);
  expect(content).toStartWith("Voice note: 가가");
});

test("post_note refuses empty, invalid or shell-substitution text and reports a Discord failure", async () => {
  for (const args of [{ text: "  \n " }, { text: 7 }, {}]) {
    const r = await tool("post_note", args);
    expect(r.ok).toBe(false);
    expect(r.result).toStartWith("not-posted:");
  }
  const unsafe = await tool("post_note", { text: "run $(whoami)" });
  expect(unsafe.ok).toBe(false);
  expect(unsafe.result).toStartWith("not-posted:");
  expect(requests).toHaveLength(0);
  reply = { status: 403, headers: {}, body: '{"message":"Missing Access"}' };
  const denied = await tool("post_note", { text: "메모" });
  expect(denied.ok).toBe(false);
  expect(denied.result).toContain("403");
  expect(requests).toHaveLength(1);
});

test("an unknown tool runs nothing", async () => {
  expect(await tool("run_shell", { command: "ls" })).toEqual({ ok: false, result: "unknown tool: run_shell" });
  expect(world.calls).toHaveLength(0);
  expect(requests).toHaveLength(0);
});
