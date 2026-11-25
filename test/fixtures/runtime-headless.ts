import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultConfig } from "../../skills/cataly-mode/scripts/src/config.ts";
import type { FlowDeps } from "../../skills/cataly-mode/scripts/src/done-flow.ts";
import { Registry } from "../../skills/cataly-mode/scripts/src/registry.ts";
import { run, type Runner } from "../../skills/cataly-mode/scripts/src/run.ts";
import { shq } from "../../src/delivery.ts";

const fakeHost = resolve(import.meta.dir, "headless-rpc.ts");
const closeProcessTable = ["ps", "-A", "-o", "pid="] as const;
export const noExternal: Runner = async () => ({ code: 1, out: "", err: "" });

export function headlessFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cataly-headless-test-")));
  const stateDir = join(home, "state");
  const cwd = join(home, "work");
  mkdirSync(cwd);
  const omp = join(home, "omp");
  writeFileSync(omp, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(fakeHost)} "$@"\n`, { mode: 0o700 });
  const path = join(home, "config.json");
  const trace = join(home, "trace.jsonl");
  const saved = join(home, "saved.jsonl");
  const brief = join(home, "brief.txt");
  const evidence = join(cwd, "evidence.txt");
  writeFileSync(brief, "work");
  writeFileSync(evidence, "evidence");
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(process.execPath)}`,
    CATALY_HOME: home,
    CATALY_STATE_DIR: stateDir,
    CATALY_CONFIG: path,
    PI_CODING_AGENT_DIR: join(home, "omp-data"),
    CATALY_TEST_TRACE: trace,
    CATALY_TEST_SESSION: saved,
    CATALY_ASK_LAUNCHED_LANE: "stale",
  };
  const config = {
    ...defaultConfig(home),
    stateDir,
    defaultCwd: cwd,
    laneRuntime: "headless" as const,
    defaultModel: "fixture/initial",
    agentCommand: [omp, "--model", "{model}", "{prompt}"],
    nudgeAfterMin: 1,
  };
  writeFileSync(path, JSON.stringify(config));
  let now = Date.now();
  const deps: FlowDeps = {
    run: (argv) =>
      argv.length === closeProcessTable.length && closeProcessTable.every((part, index) => argv[index] === part)
        ? run(argv, { env })
        : noExternal(argv),
    registry: new Registry(stateDir),
    config,
    env,
    clock: { now: () => now, sleep: (ms) => Bun.sleep(ms) },
  };
  return {
    home,
    stateDir,
    env,
    path,
    saved,
    deps,
    input: { key: "headless-lane", title: "Native work", brief, done: `file ${evidence}` },
    advance: (ms: number) => {
      now += ms;
    },
    frames: () =>
      readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
