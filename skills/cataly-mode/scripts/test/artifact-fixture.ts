import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Artifacts } from "../src/artifacts.ts";
import { defaultConfig } from "../src/config.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { withState } from "./fakes.ts";

export const ARTIFACT_NOW = Date.parse("2026-01-01T12:00:00.000Z");
export const artifactFixture = async () => {
  const state = withState();
  const root = join(state.dir, "files");
  mkdirSync(root);
  const config = {
    ...defaultConfig(state.dir),
    stateDir: join(state.dir, "state"),
    defaultCwd: root,
    artifactRoots: [{ path: root, baseUrl: "https://files.example/reports/" }],
  };
  const registry = new Registry(config.stateDir);
  const lane: Lane = {
    key: "artifact-lane",
    title: "artifact fixture",
    thread: "none",
    brief: "brief.md",
    done: "file done.txt",
    cwd: root,
    openedAt: new Date(ARTIFACT_NOW).toISOString(),
    status: "working",
  };
  await registry.write(lane);
  const path = join(root, "report.txt");
  writeFileSync(path, "first version\n");
  writeFileSync(join(root, "done.txt"), "done\n");
  return { state, root, path, config, registry, lane, artifacts: new Artifacts(config, registry) };
};
