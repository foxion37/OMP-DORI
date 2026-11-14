import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import type { DeploymentRecord, MonitorSet } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { foregroundFixture } from "./update-deploy-foreground-setup.ts";

export async function rollbackFixture(options: { unknown?: boolean; parentShell?: boolean } = {}) {
  const f = await foregroundFixture({ ...options, rollback: true });
  const config = { ...f.config, herdr: join(f.root, "herdr") };
  const nativeConfig = join(config.releaseRoot, "native-config.json");
  mkdirSync(config.releaseRoot, { recursive: true });
  writeFileSync(nativeConfig, JSON.stringify({ update: { auto: false } }), { mode: 0o600 });
  mkdirSync(join(config.liveSource, "extension"), { recursive: true });
  writeFileSync(
    join(config.liveSource, "extension/index.ts"),
    "export const generation = 'legacy-no-health-writer';\n",
  );
  const releasePath = join(f.root, "failed-release");
  mkdirSync(join(releasePath, "extension"), { recursive: true });
  writeFileSync(join(releasePath, "extension/index.ts"), "export const generation = 'failed-next-generation';\n");
  writeFileSync(f.bootstrap.intake.path, String(Date.now()), { mode: 0o600 });
  const bootstrap: MonitorSet = {
    ...f.bootstrap,
    runtime: f.previousRuntime!,
    running: f.previousMonitors!.map((identity) => ({ name: identity.name, pid: identity.pid, identity })),
  };
  f.writeBootstrap(bootstrap);
  const frontPath = join(f.root, "foreground.json");
  writeFileSync(frontPath, JSON.stringify(f.front));
  // Only pane observation is implemented: any launch, signal or model interaction fails the test.
  writeFileSync(
    config.herdr,
    `#!${process.execPath}
import { readFileSync } from "node:fs";
const operation = process.argv[process.argv.indexOf("pane") + 1];
if (operation !== "get" && operation !== "process-info") throw new Error("unexpected mutating operation");
const result = operation === "get" ? { pane: { agent: "omp", agent_status: "idle" } }
  : { process_info: JSON.parse(readFileSync(${JSON.stringify(frontPath)}, "utf8")) };
console.log(JSON.stringify({ result }));
`,
    { mode: 0o700 },
  );
  const record: DeploymentRecord = {
    version: 1,
    id: "controlled-legacy-rollback",
    inputHash: "input",
    configHash: "config",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: sourceManifest(releasePath).hash,
    releasePath,
    directory: join(f.root, "transaction"),
    createdAt: f.previousRuntime!.startedAt,
    status: "starting",
    step: "rollback",
    bootstrap: true,
    oldRuntime: f.previousRuntime!,
    oldMonitors: f.previousMonitors!,
    oldSource: realpathSync(config.liveSource),
    oldSourceHash: sourceManifest(config.liveSource).hash,
    monitors: bootstrap,
    stopRequestedAt: f.previousRuntime!.startedAt,
    rollbackRequestedAt: f.launchRequestedAt,
    rollbackLaunchRequestedAt: f.launchRequestedAt,
    oldToolchain: {
      omp: config.omp,
      ompEntry: realpathSync(config.omp),
      ompEntryHash: digest(readFileSync(config.omp)),
      bun: process.execPath,
      bunHash: digest(readFileSync(process.execPath)),
      nativeVersion: "18.18.6",
      nativeConfig,
      nativeConfigHash: digest(readFileSync(nativeConfig)),
    },
  };
  record.toolchain = record.oldToolchain!;
  const journal = join(record.directory, "deployment.json");
  const persist = (value: DeploymentRecord): void => saveDeploymentJson(journal, value);
  persist(record);
  return { ...f, config, record, journal, persist };
}
