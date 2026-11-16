import { expect, spyOn, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deployRelease } from "../src/update/deployment.ts";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { waitForRestartLock } from "../src/update/deployment-lock.ts";
import { acquireRestartLock, processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { sourceManifest } from "../src/update/source.ts";
import { fixture } from "./update-deploy-setup.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

posix("shared restart lock waits for a live holder and only recovers a mismatched start identity", async () => {
  const { config } = fixture();
  const release = acquireRestartLock(config);
  expect(() => acquireRestartLock(config)).toThrow("restart lock is held");
  const unlocked = waitForRestartLock(config);
  release();
  await unlocked;
  mkdirSync(config.restartLock);
  const live = processIdentity(process.pid)!;
  writeFileSync(
    join(config.restartLock, "owner.json"),
    JSON.stringify({ ...live, startTicks: `${BigInt(live.startTicks) + 1n}` }),
  );
  await waitForRestartLock(config);
  const recovered = acquireRestartLock(config);
  expect(sameProcess(JSON.parse(readFileSync(join(config.restartLock, "owner.json"), "utf8")))).toBe(true);
  recovered();
});

posix.each(["wait", "acquire-race"])(
  "pre-stop restart lock %s retries within one fixed window without touching its live owner",
  async (mode) => {
    const { root, config } = fixture();
    const manifest = sourceManifest(config.liveSource);
    const input = {
      remote: root,
      candidate: config.liveSource,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      sourceHash: manifest.hash,
      publicManifest: manifest,
    };
    const sourceInode = lstatSync(config.liveSource).ino;
    const signals = spyOn(process, "kill");
    let clock = Date.now();
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    let saved: DeploymentRecord | undefined;
    const persist = (value: DeploymentRecord): void => {
      saved = structuredClone(value);
    };
    let release: (() => void) | undefined;
    try {
      if (mode === "wait") release = acquireRestartLock(config);
      const pending = deployRelease(config, input, undefined, persist);
      // An initially empty async wait yields before the rollout can acquire its own lock.
      if (mode === "acquire-race") release = acquireRestartLock(config);
      const lockInode = lstatSync(config.restartLock).ino;
      const owner = readFileSync(join(config.restartLock, "owner.json"), "utf8");
      const held = await pending;
      expect(held).toMatchObject({ status: "held", step: "prepare", retryableHold: true });
      expect(held.error).toContain(mode === "wait" ? "health bound" : "restart lock is held");
      expect(held.preparedAt).toBeUndefined();
      expect(held.stopRequestedAt).toBeUndefined();
      expect(held.launchRequestedAt).toBeUndefined();
      expect(held.oldRuntime).toBeUndefined();
      expect(lstatSync(config.liveSource).ino).toBe(sourceInode);
      expect(lstatSync(config.restartLock).ino).toBe(lockInode);
      expect(readFileSync(join(config.restartLock, "owner.json"), "utf8")).toBe(owner);
      expect(lstatSync(config.launcherPath, { throwIfNoEntry: false })).toBeUndefined();
      expect(signals).not.toHaveBeenCalled();
      const deadline = held.retryDeadlineAt!;
      const oldRuntime = {
        ...processIdentity(process.pid)!,
        role: "dori" as const,
        pane: config.pane,
        sessionId: config.sessionId,
        sessionFile: join(root, "session.jsonl"),
        startedAt: held.createdAt,
        cwd: root,
      };
      const journal: DeploymentRecord = {
        ...held,
        oldRuntime,
        oldMonitors: [],
        oldSource: config.liveSource,
        oldSourceHash: manifest.hash,
        preparedAt: held.createdAt,
        step: "stop",
      };
      delete journal.retryDeadlineAt;
      saveDeploymentJson(join(held.directory, "deployment.json"), journal);
      clock = Date.parse(deadline) - 1;
      const repeated = await deployRelease(config, input, { ...journal, retryDeadlineAt: deadline }, persist);
      expect(repeated).toMatchObject({ status: "held", retryableHold: true, retryDeadlineAt: deadline });
      clock++;
      const terminal = await deployRelease(config, input, saved, persist);
      expect(terminal).toMatchObject({
        status: "held",
        retryDeadlineAt: deadline,
        oldRuntime,
        oldMonitors: [],
        oldSourceHash: manifest.hash,
      });
      expect(terminal.retryableHold).toBeUndefined();
      expect(terminal.stopRequestedAt).toBeUndefined();
      expect(saved).toEqual(terminal);
      expect(terminal.launchRequestedAt).toBeUndefined();
      expect(terminal.error).toContain("retry deadline");
      expect(lstatSync(config.liveSource).ino).toBe(sourceInode);
      expect(lstatSync(config.restartLock).ino).toBe(lockInode);
      expect(readFileSync(join(config.restartLock, "owner.json"), "utf8")).toBe(owner);
      expect(signals).not.toHaveBeenCalled();
    } finally {
      release?.();
      signals.mockRestore();
      now.mockRestore();
    }
  },
);
