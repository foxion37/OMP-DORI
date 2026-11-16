import { expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deployRelease, restartDeployment } from "../src/update/deployment.ts";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { saveRestartIntent } from "../src/update/deployment-restart-state.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { managedBashFixture } from "./update-deploy-managed-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

linux.each(["release", "restart"] as const)(
  "a failed %s health observation retains its cause when rollback meets an approval boundary",
  async (mode) => {
    const f = await managedBashFixture();
    const config = { ...f.config, healthTimeoutMs: 0, stopTimeoutMs: 100 };
    const manifest = sourceManifest(f.record.releasePath);
    const input = {
      remote: f.root,
      candidate: f.record.releasePath,
      commit: f.record.commit,
      tree: f.record.tree,
      sourceHash: manifest.hash,
      publicManifest: manifest,
    };
    const record: DeploymentRecord = {
      ...f.record,
      inputHash: digest(JSON.stringify(input)),
      configHash: digest(JSON.stringify(config)),
      releasePath:
        mode === "release"
          ? join(config.releaseRoot, "releases", `${input.commit}-${input.sourceHash.slice(0, 16)}`)
          : f.record.releasePath,
      preparedAt: f.record.createdAt,
      step: "health",
      launchProcess: f.runtime,
    };
    f.writeState({ approvalPending: true });
    f.writeHealth({ ...f.health, presetLoaded: false });
    let persisted: DeploymentRecord | undefined;
    const persist = (value: DeploymentRecord): void => {
      saveDeploymentJson(f.journal, value);
      persisted = structuredClone(value);
    };
    if (mode === "restart") saveRestartIntent(config, record);
    else {
      cpSync(input.candidate, record.releasePath, { recursive: true });
      expect(sourceManifest(record.releasePath).hash).toBe(input.sourceHash);
      rmSync(join(config.releaseRoot, "restart-pending.json"));
      persist(record);
    }
    const result =
      mode === "restart" ? await restartDeployment(config) : await deployRelease(config, input, record, persist);
    const errors = {
      status: "failed",
      error:
        mode === "restart"
          ? "native code or desired monitor health has not converged"
          : "running source pointer differs",
      rollbackError: "resumed Dori has owner work or an approval; rollback is held until idle",
    };
    expect(result).toMatchObject(errors);
    expect(JSON.parse(readFileSync(f.journal, "utf8"))).toMatchObject(errors);
    if (mode === "release") expect(persisted).toMatchObject(errors);
    expect(sameProcess(f.runtime)).toBe(true);
    for (const monitor of f.bootstrap.running!) expect(sameProcess(monitor.identity!)).toBe(true);
    expect(existsSync(f.signalPath)).toBe(false);
    expect(existsSync(f.effect)).toBe(false);
  },
);
