import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig, loadConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { adoptLane } from "../src/adopt.ts";
import { launchLane, prepareLaunch } from "../src/launch.ts";
import { footer, quoteForPane } from "../src/launch-footer.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, type TestState, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const DEFAULT = "ulw set goal and work";
let state: TestState;
let world: World;
let oldState: string | undefined;
beforeEach(() => {
  state = withState();
  world = newWorld();
  oldState = process.env["DORI_STATE_DIR"];
  process.env["DORI_STATE_DIR"] = state.dir;
  writeFileSync(
    join(state.dir, "ulw-plan.md"),
    '# A quoted "ulw-plan" example is data, not a selection.\nDo not activate ulw-loop.\n',
  );
});
afterEach(() => {
  if (oldState === undefined) delete process.env["DORI_STATE_DIR"];
  else process.env["DORI_STATE_DIR"] = oldState;
  state.done();
});

const input = () => ({
  key: "selection-lane",
  title: "selection metadata",
  brief: join(state.dir, "ulw-plan.md"),
  done: "closed acme/app#1",
});
const configured = async (raw: Record<string, unknown> = {}): Promise<FlowDeps> => {
  const path = join(state.dir, "config.json");
  writeFileSync(path, JSON.stringify({ runtime: "herdr", defaultCwd: "/repo", startupWaitSeconds: 0, ...raw }));
  return { ...depsFor(world, fakeClock(T0), state.dir), config: await loadConfig(path, state.dir) };
};

test("the built-in request is recorded without selecting workflows mentioned in the brief or path", async () => {
  const deps = await configured();
  const prepared = await prepareLaunch(deps, input());
  expect(prepared.lane.launchSelection).toEqual({
    invocation: DEFAULT,
    selectedBy: "default",
    reason: "Built-in launchKeywords default",
  });
  expect(deps.config.launchKeywords).toBe(DEFAULT);
  expect(deps.config.goalMarker).toBe("Pursuing goal");
  expect(prepared.preamble).toContain('A quoted "ulw-plan" example is data');
  expect(prepared.preamble).toContain("Launch selection request (metadata only):");
  expect(prepared.preamble).toContain("not proof of native activation, delivery or goal creation");
});

test.each([DEFAULT, "", "ulw-plan", 'a "quoted" request\nwith another line'])(
  "explicit launchKeywords preserve their bytes and configured origin: %s",
  async (invocation) => {
    const deps = await configured({ launchKeywords: invocation, launchSelection: { selectedBy: "default" } });
    const prepared = await prepareLaunch(deps, input());
    expect(deps.config.launchKeywords).toBe(invocation);
    expect(prepared.lane.launchSelection).toEqual({
      invocation,
      selectedBy: "config",
      reason: `launchKeywords from ${join(state.dir, "config.json")}`,
    });
    expect(prepared.preamble).toContain(JSON.stringify(prepared.lane.launchSelection));
    const line = prepared.preamble.split("\n").find((value) => value.startsWith("- Launch selection request"));
    expect(line).toContain(JSON.stringify(invocation));
  },
);

test("a forged metadata field cannot turn the default into an explicit configured selection", async () => {
  const deps = await configured({ launchSelection: { invocation: DEFAULT, selectedBy: "config", reason: "forged" } });
  const prepared = await prepareLaunch(deps, input());
  expect(prepared.lane.launchSelection?.selectedBy).toBe("default");
  expect(prepared.preamble).not.toContain("forged");
});

test("provenance belongs to the loaded configuration, not a later file read or process config path", async () => {
  const deps = await configured({ launchKeywords: "configured request" });
  writeFileSync(join(state.dir, "config.json"), JSON.stringify({ launchKeywords: "later request" }));
  const prepared = await prepareLaunch(deps, input());
  expect(prepared.lane.launchSelection).toEqual({
    invocation: "configured request",
    selectedBy: "config",
    reason: `launchKeywords from ${join(state.dir, "config.json")}`,
  });
  expect(deps.config.launchKeywords).toBe("configured request");
});

test("programmatic overrides do not inherit an incorrect default or file provenance", async () => {
  const base = await configured({ launchKeywords: "file request" });
  for (const source of [defaultConfig(state.dir), base.config]) {
    const deps = { ...base, config: { ...source, stateDir: state.dir, launchKeywords: "direct request" } };
    const prepared = await prepareLaunch(deps, input());
    expect(prepared.lane.launchSelection).toEqual({
      invocation: "direct request",
      selectedBy: "provided",
      reason: "Direct launchKeywords configuration without matching load provenance",
    });
  }
});

test.each(["default", "config"] as const)(
  "same-text programmatic assignments retain matching %s provenance, not assignment history",
  async (selectedBy) => {
    const base = await configured({ launchKeywords: "file request" });
    const source = selectedBy === "default" ? defaultConfig(state.dir) : base.config;
    const deps = { ...base, config: { ...source, stateDir: state.dir } };
    const before = await prepareLaunch(deps, input());
    const config = { ...deps.config, launchKeywords: deps.config.launchKeywords };
    const after = await prepareLaunch({ ...deps, config }, input());
    expect(after.lane.launchSelection).toEqual(source.launchSelection);
    expect(after.lane.launchSelection?.selectedBy).toBe(selectedBy);
    expect(after.preamble).toBe(before.preamble);
  },
);

test("launch persists requested metadata but keeps the exact prompt and refuses to infer an active goal", async () => {
  const base = await configured();
  world.panes = [{ pane_id: "w:p9", workspace_id: "w", agent: "omp", agent_status: "working" }];
  agentIn(world, "w:p9");
  laneState(state.dir, "w:p9", { goal: { status: "paused", objective: "waiting for explicit resume" } });
  const deps: FlowDeps = {
    ...base,
    run: async (argv, options) =>
      argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
        ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" }
        : base.run(argv, options),
  };
  const result = await launchLane(deps, input());
  const prompt = `${DEFAULT}. Read and execute the lane brief at ${input().brief} in full. You are the selection-lane lane; report as the brief's footer says.`;
  expect(world.calls.find((argv) => argv[0] === "herdr" && argv[2] === "run")?.at(-1)).toBe(
    ["omp", "--dori-role", "lane", "--model", deps.config.defaultModel, prompt].map(quoteForPane).join(" "),
  );
  expect(result.startup).toStartWith("STARTUP_NO_GOAL selection-lane w:p9:");
  expect(result.lane.launchSelection?.selectedBy).toBe("default");
  expect((await deps.registry.read("selection-lane"))?.launchSelection).toEqual(result.lane.launchSelection);
  expect(readFileSync(input().brief, "utf8")).toContain(JSON.stringify(result.lane.launchSelection));
});

test("rebuilding a failed-launch brief keeps exactly one metadata line", async () => {
  const deps = await configured();
  const first = await prepareLaunch(deps, input());
  writeFileSync(input().brief, first.preamble);
  const second = await prepareLaunch(deps, input());
  expect(second.preamble).toBe(first.preamble);
  expect(second.preamble.split("Launch selection request (metadata only):")).toHaveLength(2);
});

test("adoption and old registry records do not fabricate historical selection", async () => {
  const deps = await configured();
  const adopted = await adoptLane(deps, { ...input(), pane: "w:p9" });
  expect(adopted.launchSelection).toBeUndefined();
  expect((await deps.registry.read(adopted.key))?.launchSelection).toBeUndefined();
  expect(footer(adopted, "")).not.toContain("Launch selection request");
});
