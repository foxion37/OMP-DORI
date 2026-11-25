import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LaunchError, launchLane } from "../src/launch.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const REFUSED = 'lane key "lead" is reserved for the lead';
const cli = join(import.meta.dir, "../src/cli.ts");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

// Nothing written: no lanes directory, no reports journal, and only the files the test made itself.
const stateFiles = (): string[] => readdirSync(state.dir).sort();

test("launch refuses the lane key lead before it writes the brief, the registry or a tab", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const error = await launchLane(deps, { key: "lead", title: "t", brief, done: "closed acme/app#3" }).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LaunchError);
  expect((error as Error).message).toBe(REFUSED);
  expect(await deps.registry.read("lead")).toBeNull();
  expect(readFileSync(brief, "utf8")).toBe("# brief\n");
  expect(world.calls).toEqual([]);
  expect(stateFiles()).toEqual(["brief.md"]);
});

test("cataly launch with key lead exits 1 with the reserved message and writes nothing", async () => {
  const config = join(state.dir, "config.json");
  const brief = join(state.dir, "brief.md");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
  writeFileSync(brief, "# brief\n");
  const invoke = (...args: string[]) =>
    run(["env", `CATALY_CONFIG=${config}`, `CATALY_STATE_DIR=${state.dir}`, process.execPath, cli, ...args]);
  const common = ["--title", "t", "--brief", brief, "--done", "closed acme/app#3"];
  for (const args of [
    ["launch", "lead", ...common],
    ["launch", "lead", ...common, "--dry-run"],
  ]) {
    const r = await invoke(...args);
    expect({ args, code: r.code, err: r.err.trim() }).toEqual({ args, code: 1, err: REFUSED });
  }
  expect(readFileSync(brief, "utf8")).toBe("# brief\n");
  expect(stateFiles()).toEqual(["brief.md", "config.json"]);
});
