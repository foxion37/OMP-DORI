import { expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deployRelease, restartDeployment } from "../src/update/deployment.ts";
import { readActiveDeployment } from "../src/update/deployment-active.ts";
import { capturePointer, saveDeploymentJson } from "../src/update/deployment-files.ts";
import { prepareLauncher } from "../src/update/deployment-handoff.ts";
import { observeDeploymentHealth } from "../src/update/deployment-health.ts";
import { nativeCli } from "../src/update/deployment-native.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { readRestartIntent, saveRestartIntent } from "../src/update/deployment-restart-state.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { nativeUiConsumerFixture } from "./update-deploy-native-ui-consumer-setup.ts";

const linux = test.skipIf(process.platform !== "linux");
linux.each([
  ["release", "delayed"],
  ["restart", "delayed"],
  ["release", "late"],
  ["restart", "late"],
  ["release", "undelivered"],
  ["restart", "undelivered"],
  ["release", "legacy"],
  ["restart", "legacy"],
] as const)(
  "uncertain UI ack stays safe across %s and %s exit",
  async (mode, outcome) => {
    const legacy = outcome === "legacy";
    const f = await nativeUiConsumerFixture(legacy ? "undelivered" : outcome);
    try {
      const { config } = f;
      const manifest = sourceManifest(config.liveSource);
      const input = {
        remote: f.root,
        candidate: config.liveSource,
        commit: f.record.commit,
        tree: f.record.tree,
        sourceHash: manifest.hash,
        publicManifest: manifest,
      };
      const record: DeploymentRecord = {
        ...f.record,
        configHash: digest(JSON.stringify(config)),
        inputHash: digest(JSON.stringify(input)),
        releasePath:
          mode === "release"
            ? join(config.releaseRoot, "releases", `${input.commit}-${input.sourceHash.slice(0, 16)}`)
            : f.record.releasePath,
        oldRuntime: f.runtime,
        oldMonitors: f.bootstrap.running!.map((entry) => ({
          ...entry.identity!,
          name: entry.name,
          argv: readFileSync(`/proc/${entry.pid}/cmdline`, "utf8").split("\0").filter(Boolean),
        })),
        monitors: f.bootstrap,
        preparedAt: f.record.createdAt,
        status: "prepared",
        step: "prepare",
      };
      delete record.stopRequestedAt;
      delete record.launchRequestedAt;
      if (mode === "release") {
        cpSync(input.candidate, record.releasePath, { recursive: true });
        const launcher = prepareLauncher(config, record);
        record.pointers = [
          capturePointer(config.liveSource, record.releasePath, record.id),
          capturePointer(config.launcherPath, launcher, record.id),
        ];
        rmSync(join(config.releaseRoot, "restart-pending.json"));
        saveDeploymentJson(f.journal, record);
      } else saveRestartIntent(config, record);
      const old = await observeDeploymentHealth(
        config,
        nativeCli(config),
        record,
        config.liveSource,
        f.runtime.startedAt,
      );
      expect(sameProcess(f.runtime, old)).toBe(true);
      const starts = join(f.root, "starts");
      const before = readFileSync(starts, "utf8").trim().split("\n").length;
      let persisted: DeploymentRecord | undefined;
      const invoke = (previous: DeploymentRecord): Promise<DeploymentRecord> =>
        mode === "restart"
          ? restartDeployment(config)
          : deployRelease(config, input, previous, (value) => {
              persisted = structuredClone(value);
            });
      let result = await invoke(record);
      let requestedAt = result.nativeUiExitRequestedAt;
      if (outcome !== "delayed") {
        expect(result).toMatchObject({ status: "held", step: "stop" });
        expect(result.error).toBe("native UI exit acknowledgement is unavailable and exit remains unobserved");
        expect(requestedAt).toBeDefined();
        expect(result.rollbackRequestedAt).toBeUndefined();
        expect(result.rollbackHealthyAt).toBeUndefined();
        expect(result.rollbackError).toBeUndefined();
        expect(sameProcess(f.runtime)).toBe(true);
        if (mode === "release") expect(persisted).toMatchObject({ retryableHold: true, step: "stop" });
        else expect(readRestartIntent(config)!.nativeUiExitRequestedAt).toBe(requestedAt);
        const stillHealthy = await observeDeploymentHealth(
          config,
          nativeCli(config),
          result,
          config.liveSource,
          f.runtime.startedAt,
        );
        expect(sameProcess(f.runtime, stillHealthy)).toBe(true);
        if (outcome === "undelivered" || legacy) {
          if (legacy) {
            const { runtime: _runtime, ...previousConfig } = config;
            result = { ...result, configHash: digest(JSON.stringify(previousConfig)) };
            saveDeploymentJson(f.journal, result);
            if (mode === "restart") saveRestartIntent(config, result);
          }
          result = await invoke(result);
          expect(result).toMatchObject({ status: "held", step: "stop", nativeUiExitRequestedAt: requestedAt });
          expect(sameProcess(f.runtime)).toBe(true);
          expect(result.rollbackRequestedAt).toBeUndefined();
        }
        // Finish the delayed normal exit, or independently end an actor whose key was never delivered.
        f.closeNativeInput();
        result = await invoke(result);
      }
      requestedAt ??= result.nativeUiExitRequestedAt;
      expect(result).toMatchObject({ status: "healthy", step: "done", nativeUiExitRequestedAt: requestedAt });
      expect(sameProcess(f.runtime)).toBe(false);
      expect(sameProcess(result.runtime!)).toBe(true);
      expect(result.runtime!.pid).not.toBe(f.runtime.pid);
      expect(result.rollbackRequestedAt).toBeUndefined();
      expect(result.rollbackHealthyAt).toBeUndefined();
      expect(result.rollbackError).toBeUndefined();
      expect(JSON.parse(readFileSync(f.journal, "utf8"))).toMatchObject({ status: "healthy", step: "done" });
      expect(readActiveDeployment(config)!.runtime.pid).toBe(result.runtime!.pid);
      if (mode === "restart") expect(readRestartIntent(config)).toBeUndefined();
      const requests = readFileSync(f.requests, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.filter((request) => request.kind === "key")).toEqual([{ kind: "key", line: "ctrl+d" }]);
      expect(requests.filter((request) => request.kind === "run")).toHaveLength(1);
      expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(before + 1);
      expect(existsSync(f.signalPath)).toBe(false);
    } finally {
      f.closeRequests();
    }
  },
  10_000,
);
