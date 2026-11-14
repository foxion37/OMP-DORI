import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownReleaseRoot } from "../src/update/deployment-files.ts";
import { saveRestartIntent } from "../src/update/deployment-restart-state.ts";
import type { DeploymentRecord, MonitorSet } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { foregroundFixture } from "./update-deploy-foreground-setup.ts";

export async function managedBashFixture(options: Parameters<typeof foregroundFixture>[0] = {}) {
  const f = await foregroundFixture({ rollback: true, paneShell: true, stoppable: true, ...options });
  const config = { ...f.config, herdr: join(f.root, "herdr"), stopTimeoutMs: 2_000 };
  ownReleaseRoot(config);
  const nativeConfig = join(config.releaseRoot, "native-config.json");
  writeFileSync(nativeConfig, JSON.stringify({ update: { auto: false } }), { mode: 0o600 });
  const releasePath = config.liveSource;
  mkdirSync(join(releasePath, "extension"), { recursive: true });
  writeFileSync(join(releasePath, "extension/index.ts"), "export const generation = 'managed';\n");
  writeFileSync(f.bootstrap.intake.path, String(Date.now()), { mode: 0o600 });
  const bootstrap: MonitorSet = {
    ...f.bootstrap,
    runtime: f.previousRuntime!,
    running: f.previousMonitors!.map((identity) => ({ name: identity.name, pid: identity.pid, identity })),
  };
  f.writeBootstrap(bootstrap);
  const health = {
    ...f.health,
    source: releasePath,
    extensionHash: digest(readFileSync(join(releasePath, "extension/index.ts"))),
    updatedAt: new Date().toISOString(),
  };
  f.writeHealth(health);
  const observation = join(f.root, "foreground.json");
  const effect = join(f.root, "pane-run-effects");
  const writeObservation = (status?: string): void => {
    const current = f.observe();
    writeFileSync(observation, JSON.stringify({ ...current, ...(status ? { status } : {}) }));
  };
  writeObservation();
  writeFileSync(
    config.herdr,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const operation = process.argv[process.argv.indexOf("pane") + 1];
if (operation === "run") {
  appendFileSync(${JSON.stringify(effect)}, JSON.stringify(process.argv) + "\\n");
  process.exit(91);
}
const { front, status } = JSON.parse(readFileSync(${JSON.stringify(observation)}, "utf8"));
if (operation !== "get" && operation !== "process-info") throw new Error("unexpected pane operation");
const result = operation === "get" ? { pane: { agent: "omp", agent_status: status } } : { process_info: front };
console.log(JSON.stringify({ result }));
`,
    { mode: 0o700 },
  );
  const id = `restart-${randomUUID()}`;
  const record: DeploymentRecord = {
    version: 1,
    id,
    inputHash: "managed-fixture",
    configHash: digest(JSON.stringify(config)),
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: sourceManifest(releasePath).hash,
    releasePath,
    directory: join(config.releaseRoot, "transactions", id),
    createdAt: f.previousRuntime!.startedAt,
    status: "starting",
    step: "start",
    bootstrap: false,
    oldRuntime: f.previousRuntime!,
    oldMonitors: f.previousMonitors!,
    oldSource: realpathSync(releasePath),
    oldSourceHash: sourceManifest(releasePath).hash,
    monitors: bootstrap,
    stopRequestedAt: f.previousRuntime!.startedAt,
    launchRequestedAt: f.launchRequestedAt,
    toolchain: {
      omp: config.omp,
      ompEntry: realpathSync(config.omp),
      ompEntryHash: digest(readFileSync(config.omp)),
      bun: process.execPath,
      bunHash: digest(readFileSync(process.execPath)),
      nativeVersion: "18.18.8",
      nativeConfig,
      nativeConfigHash: digest(readFileSync(nativeConfig)),
    },
  };
  record.oldToolchain = record.toolchain!;
  const persist = (value: DeploymentRecord): void => saveRestartIntent(config, value);
  persist(record);
  return {
    ...f,
    config,
    record,
    health,
    persist,
    effect,
    writeObservation,
    journal: join(record.directory, "deployment.json"),
  };
}
