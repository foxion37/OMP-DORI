import { afterEach, beforeEach, expect, test } from "bun:test";
import { freshnessTick } from "../src/freshness.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { Reports, reportId } from "../src/reports.ts";
import type { Lane } from "../src/registry.ts";
import { agentIn, laneState, depsFor, fakeClock, newWorld, sent, withState, type TestState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const lane: Lane = {
  key: "policy-lane",
  title: "policy",
  thread: "discord:123",
  pane: "w:p7",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
};
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test.each(["working", "blocked", "error", "shell", "unknown"])("idle-only does not nudge %s", async (status) => {
  const world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: status }];
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, { freshness: { nudge: "idle-only" } });
  await deps.registry.write(lane);
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect((await deps.registry.read(lane.key))?.lastNudgeAt).toBeUndefined();
});

test("idle-only nudges a live idle lane once and preserves the delivery gate", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "idle" }];
  agentIn(world, "w:p7");
  laneState(state.dir, "w:p7", { agentStatus: "idle" });
  world.onEnterStatus = "working";
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, { freshness: { nudge: "idle-only" } });
  await deps.registry.write(lane);
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect(sent(world)).toHaveLength(1);
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
});

test("an idle status over a shell is not delivered or recorded as a nudge", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "idle", foreground: "bash" }];
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, { freshness: { nudge: "idle-only" } });
  await deps.registry.write(lane);
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect((await deps.registry.read(lane.key))?.lastNudgeAt).toBeUndefined();
});

test("summary-only posts the owner summary, not the lead detail, and remembers its exact identity", async () => {
  const world = newWorld();
  world.screen = "Working (1m)";
  const clock = fakeClock(T0 + 21 * MIN);
  const deps = depsFor(world, clock, state.dir, {
    freshness: { nudge: "idle-only", postRaw: false, autoPostKinds: ["milestone"] },
    hooks: { threadReply: ["notify", "{thread}", "{text}"] },
  });
  await deps.registry.write({ ...lane, reportProtocol: "jsonl-v1" });
  const reports = new Reports(state.dir);
  const report = reports.report(
    lane.key,
    "milestone",
    "R1 private implementation detail",
    T0,
    undefined,
    "Tests passed",
  );
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["posted"]);
  expect(world.calls.find((c) => c[0] === "notify")?.[2]).toBe("Progress (from the lane's last report): Tests passed");
  expect((await deps.registry.read(lane.key))?.lastPostedReportId).toBe(reportId(report));
  clock.at += 30 * MIN;
  await freshnessTick(deps, "/home/test");
  expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
});

test.each(["blocker", "question", "halted", "done"] as const)(
  "excluded %s reports alert the lead once without posting",
  async (kind) => {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, {
      freshness: { autoPostKinds: ["milestone"] },
      hooks: { threadReply: ["notify", "{text}"] },
    });
    await deps.registry.write({ ...lane, reportProtocol: "jsonl-v1" });
    new Reports(state.dir).report(lane.key, kind, "Internal question", T0, undefined, "Please decide");
    expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["unrelayed"]);
    expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    expect(sent(world)).toEqual([]);
    expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
  },
);

test.each([true, false])("summary-only alerts rather than leaking detail (hook=%s)", async (hook) => {
  const world = newWorld();
  world.screen = "Working (1m)";
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, {
    freshness: { postRaw: false, nudge: "idle-only" },
    hooks: hook ? { threadReply: ["notify", "{text}"] } : {},
  });
  await deps.registry.write({ ...lane, reportProtocol: "jsonl-v1" });
  new Reports(state.dir).report(lane.key, "milestone", "Internal detail", T0);
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["unrelayed"]);
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
});

test("summary-only never sends an adopted lane's screen report", async () => {
  const world = newWorld();
  world.screen = `[REPORT] ${lane.key} | milestone | internal detail`;
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, {
    freshness: { postRaw: false, nudge: "idle-only" },
    hooks: { threadReply: ["notify", "{text}"] },
  });
  await deps.registry.write(lane);
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["pending-report"]);
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["unrelayed"]);
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
});

test.each([[null], [[]], [{ nudge: "idle" }], [{ postRaw: "false" }], [{ autoPostKinds: ["typo"] }], [{ typo: true }]])(
  "invalid policy %# fails configuration loading",
  async (freshness) => {
    const path = `${state.dir}/config.json`;
    await Bun.write(path, JSON.stringify({ freshness }));
    await expect(loadConfig(path, state.dir)).rejects.toBeInstanceOf(ConfigError);
  },
);

test("owner summaries round-trip and invalid summaries cannot enter the journal", () => {
  const reports = new Reports(state.dir);
  const report = reports.report(lane.key, "milestone", "detail", T0, undefined, "Owner summary");
  expect(reports.read(lane.key)?.lastReport).toEqual(report);
  expect(reportId(reports.read(lane.key)!.lastReport!)).toBe(reportId(report));
  expect(() => reports.report(lane.key, "milestone", "detail", T0, undefined, " ")).toThrow("invalid owner summary");
});
