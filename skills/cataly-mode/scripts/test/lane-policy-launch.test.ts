import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, type CatalyConfig } from "../src/config.ts";
import { launchLane, prepareLaunch } from "../src/launch.ts";
import { isPolicyLaneCommand } from "../src/lane-policy-launch.ts";
import { currentLanePolicy, prepareLanePolicy, readLanePolicy, writeLanePolicy } from "../src/lane-policy-store.ts";
import { depsFor, fakeClock, href, newWorld, sid, type TestState, withState } from "./fakes.ts";

let state: TestState;
const NOW = Date.parse("2026-01-01T00:00:00Z");
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const setup = (patch: Partial<CatalyConfig> = {}, configured = true) => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# policy launch\n");
  const world = newWorld();
  const deps = depsFor(world, fakeClock(NOW), state.dir, {
    defaultCwd: state.dir,
    agentCommand: defaultConfig(state.dir).agentCommand,
    ...(configured ? { lanePolicy: { denyBash: ["sudo"] } } : {}),
    ...patch,
  });
  const observed = { created: 0, started: 0, env: {} as Readonly<Record<string, string>> };
  world.onCreate = (spec) => {
    observed.created++;
    observed.env = spec.env;
  };
  world.onStart = () => {
    observed.started++;
    if (deps.config.lanePolicy)
      expect(readLanePolicy(observed.env["CATALY_LANE_POLICY"] ?? "").snapshot.key).toBe("demo");
  };
  const input = { key: "demo", title: "fixture", brief, done: "file /test/done" };
  return { deps, world, observed, input, file: join(state.dir, "lanes/demo/policy.json") };
};
const STARTED = `STARTUP_OK demo headless:${sid(1)}`;

test("dry run is read-only; real launch hands the same persisted snapshot to its native lane", async () => {
  const f = setup();
  await prepareLaunch(f.deps, f.input);
  expect(f.observed).toMatchObject({ created: 0, started: 0 });
  expect(existsSync(f.file)).toBe(false);
  expect(await f.deps.registry.read("demo")).toBeNull();
  expect((await launchLane(f.deps, f.input)).startup).toBe(STARTED);
  expect(f.observed).toMatchObject({ created: 1, started: 1 });
  expect(currentLanePolicy(state.dir, "demo").snapshot.denyBash).toEqual(["sudo"]);
});

test("ordinary launches clear an inherited binding instead of protecting an unrelated lane", async () => {
  const f = setup({}, false);
  const deps = { ...f.deps, env: { CATALY_LANE_POLICY: "inherited foreign policy" } };
  expect((await launchLane(deps, f.input)).startup).toBe(STARTED);
  expect(f.observed.env["CATALY_LANE_POLICY"]).toBe("");
  expect(f.world.sessions[sid(1)]?.env?.["CATALY_LANE_POLICY"]).toBe("");
  expect(existsSync(f.file)).toBe(false);
});

test("configured policy refuses custom agents or missing, conflicting native lane roles before effects", async () => {
  for (const agentCommand of [
    ["custom-agent"],
    ["omp"],
    ["omp", "--cataly-role", "cataly"],
    ["omp", "--cataly-role", "lane", "--cataly-role", "cataly"],
    ["sh", "-c", "exec omp", "--cataly-role", "lane"],
    ["env", "-S", "omp", "--cataly-role", "lane"],
    ["env", "--ignore-environment", "omp", "--cataly-role", "lane", "{prompt}"],
    ["npx", "-c", "omp", "--cataly-role", "lane"],
    ["omp", "--", "--cataly-role", "lane"],
    ["omp", "--model", "--cataly-role", "lane"],
    ["omp", "-e", "--cataly-role=lane"],
    ["omp", "--cataly-role", "lane", "--plan", "--cataly-role=cataly"],
    ["omp", "--profile", "work", "--cataly-role", "lane"],
    ["node", "--eval", "0", "omp", "--cataly-role", "lane"],
    ["bun", "--define", "--cataly-role=lane", "/opt/omp"],
    ["omp", "--cataly-role", "lane", "--resume", "existing-session"],
  ]) {
    const f = setup({ agentCommand });
    await expect(launchLane(f.deps, f.input)).rejects.toThrow("lanePolicy requires");
    expect(f.observed.created).toBe(0);
    expect(existsSync(f.file)).toBe(false);
  }
});

test("the policy admission parser recognizes direct, environment, package, and source lane entries", () => {
  for (const agentCommand of [
    defaultConfig(state.dir).agentCommand,
    ["omp", "--cataly-role=lane", "{prompt}"],
    ["omp", "Review the brief", "--cataly-role", "lane", "{prompt}"],
    ["omp", "--cataly-role", "lane", "--", "--resume is literal prompt text"],
    [
      "/release/scripts/consumer/omp",
      "--no-extensions",
      "-e",
      "/release/extension",
      ...defaultConfig(state.dir).agentCommand.slice(1),
    ],
    [
      "/side/releases/current/scripts/consumer/omp",
      "--no-extensions",
      "-e",
      "/side/extension",
      "--config",
      "/side/omp.yml",
      "--config",
      "/side/discovery/omp.yml",
      ...defaultConfig(state.dir).agentCommand.slice(1),
    ],
    ["env", "TERM=xterm", "omp", "--cataly-role", "lane"],
    ["npx", "@oh-my-pi/pi-coding-agent@18.20.0", "--cataly-role", "lane"],
    ["npm", "exec", "--", "omp", "--cataly-role", "lane"],
    ["node", "/opt/@oh-my-pi/pi-coding-agent/dist/cli.js", "--cataly-role", "lane"],
    [
      "bun",
      "--preload",
      "/opt/omp/packages/coding-agent/scripts/omp.ts",
      "/opt/omp/packages/coding-agent/src/cli.ts",
      "--cataly-role",
      "lane",
    ],
  ]) {
    expect(isPolicyLaneCommand(agentCommand), agentCommand.join(" ")).toBe(true);
  }
});

test("a losing launch cannot replace the registered winner's policy snapshot", async () => {
  const f = setup();
  const winner = prepareLanePolicy(state.dir, "demo", { denyBash: ["winner"] });
  if (!winner) throw new Error("expected winner policy");
  f.world.onCreate = async () => {
    await f.deps.registry.create({
      ...f.input,
      thread: "none",
      openedAt: new Date(NOW).toISOString(),
      sessionRef: href(sid(99)),
    });
    writeLanePolicy(winner);
  };
  await expect(launchLane(f.deps, f.input)).rejects.toThrow("already registered");
  expect(f.observed.started).toBe(0);
  expect(currentLanePolicy(state.dir, "demo").snapshot).toEqual(winner.snapshot);
  expect((await f.deps.registry.read("demo"))?.sessionRef).toEqual(href(sid(99)));
});

test("snapshot persistence failure leaves an inspectable registered lane but never starts an agent", async () => {
  const f = setup();
  mkdirSync(f.file, { recursive: true });
  await expect(launchLane(f.deps, f.input)).rejects.toThrow();
  expect(f.observed).toMatchObject({ created: 1, started: 0 });
  expect((await f.deps.registry.read("demo"))?.sessionRef).toEqual(href(sid(1)));
});
