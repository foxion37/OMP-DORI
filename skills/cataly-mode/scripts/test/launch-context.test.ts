import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareLaunch } from "../src/launch.ts";
import { footer, laneFooterFor, originalBrief } from "../src/launch-footer.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sid, type TestState, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("new native lanes report to the attested native lead, but not to a session that lost the lead role", async () => {
  const world = newWorld();
  const id = sid(1);
  world.sessions[id] = {
    status: "idle",
    role: "cataly",
    harnessRole: "lead",
    sessionId: "lead-session",
    sessionFile: "/sessions/lead-session.jsonl",
    pid: 4001,
    goal: { status: "none" },
    held: false,
  };
  writeFileSync(join(state.dir, "roles.json"), JSON.stringify({ lead: `headless:${id}` }));
  const deps = { ...depsFor(world, fakeClock(T0), state.dir), env: { CATALY_HOME: state.dir } };
  const lane: Lane = {
    key: "new-lane",
    title: "title",
    thread: "none",
    brief: "/brief",
    done: "file /result",
    openedAt: new Date(T0).toISOString(),
  };
  expect(await laneFooterFor(deps, lane)).toContain(`harness send headless:${id} --text "$line"`);
  world.sessions[id] = { ...world.sessions[id]!, role: "lane" };
  expect(await laneFooterFor(deps, lane)).not.toContain("harness send");
});

test.each(["alpha", "beta"] as const)("%s context survives a reload under another repository default", async (name) => {
  const cwd = join(state.dir, name);
  const other = join(state.dir, name === "alpha" ? "beta" : "alpha");
  mkdirSync(cwd);
  mkdirSync(other);
  const brief = join(cwd, "task.md");
  const done = `file ${join(cwd, "result.json")} json:.passed=true`;
  const thread = name === "alpha" ? "discord:11111111111111111" : "discord:22222222222222222";
  const body = [
    `Source: owner-message-${name}`,
    `Allowed repository: ${cwd}; branch: fix/${name}`,
    `Acceptance: ${done}`,
    "Preserve: owner.txt",
    `Pending effect: inspect receipt-${name} before retry`,
    `Resume checkpoint: completed-${name}`,
  ].join("\n");
  writeFileSync(brief, body);
  writeFileSync(join(cwd, "owner.txt"), "existing owner change");
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0), state.dir, { defaultCwd: other });
  const prepared = await prepareLaunch(deps, { key: `lane-${name}`, title: name, brief, done, thread, cwd });
  expect(originalBrief(prepared.preamble)).toBe(body);
  expect(prepared.preamble).toContain(`- Task brief: ${JSON.stringify(brief)}.`);
  expect(prepared.preamble).toContain(`- Recorded working directory: ${JSON.stringify(cwd)}.`);
  expect(prepared.preamble).not.toContain(`- Recorded working directory: ${JSON.stringify(other)}.`);
  writeFileSync(brief, prepared.preamble);
  expect(await deps.registry.create(prepared.lane)).toBe(true);

  const restarted = depsFor(world, fakeClock(T0 + 1000), state.dir, { defaultCwd: other });
  const restored = await restarted.registry.read(`lane-${name}`);
  if (!restored) throw new Error("the persisted lane was lost");
  const text = footer(restored, restarted.config.leadPane, {}, "headless");
  expect(text).toContain(`- Key: lane-${name}. Work thread: ${thread}.`);
  expect(text).toContain(`- Done = ${done}.`);
  expect(text).toContain(`- Recorded working directory: ${JSON.stringify(cwd)}.`);
  expect(originalBrief(readFileSync(restored.brief, "utf8"))).toBe(body);
  expect(readFileSync(join(cwd, "owner.txt"), "utf8")).toBe("existing owner change");
  expect(world.calls).toEqual([]);
});

test("launch records its configured execution directory when cwd is omitted", async () => {
  const cwd = join(state.dir, "configured-repository");
  mkdirSync(cwd);
  const brief = join(state.dir, "configured-task.md");
  writeFileSync(brief, "Source: owner-message-configured");
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { defaultCwd: cwd });
  const prepared = await prepareLaunch(deps, {
    key: "configured-lane",
    title: "configured directory",
    brief,
    done: `file ${join(cwd, "result.json")} json:.passed=true`,
  });
  expect(prepared.lane.cwd).toBe(cwd);
  expect(prepared.preamble).toContain(`- Recorded working directory: ${JSON.stringify(cwd)}.`);
  expect(originalBrief(prepared.preamble)).toBe("Source: owner-message-configured");
});

const unlocated: Lane = {
  key: "context-lane",
  title: "context",
  thread: "none",
  brief: "/briefs/context.md",
  done: "closed acme/app#1",
  openedAt: new Date(T0).toISOString(),
};

test("a supplied record without cwd leaves the workspace unspecified", () => {
  const text = footer(unlocated, "");
  expect(text).toContain('- Task brief: "/briefs/context.md".');
  expect(text).not.toContain("- Recorded working directory:");
  expect(text).toContain("Resolve missing or conflicting context that matters to this task with the lead");
});

test("handoff retains original sources, scoped acceptance and unresolved effects without copying all history", () => {
  const text = footer(unlocated, "");
  expect(text).toContain("original request/source references");
  expect(text).toContain("allowed repositories, worktree/branch and observable acceptance");
  expect(text).toContain("preserved resources, unfinished external effects/receipts and resume checkpoint");
  expect(text).toContain("not the whole lead transcript");
  expect(text).toContain("Do not silently retarget this lane from another session's cwd or an unrelated message");
  expect(text).toContain("do not invent values, permissions or deadlines");
});
