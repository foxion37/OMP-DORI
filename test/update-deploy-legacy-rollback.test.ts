import { expect, test } from "bun:test";
import { procCmdline } from "../src/update/proc.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readActiveDeployment, saveActiveDeployment } from "../src/update/deployment-active.ts";
import { observeDeploymentHealth } from "../src/update/deployment-health.ts";
import { launchedProcess } from "../src/update/deployment-launch.ts";
import { legacyRollbackForeground } from "../src/update/deployment-legacy-monitors.ts";
import { readRuntimeHealth } from "../src/update/deployment-monitor-receipts.ts";
import { captureRuntime } from "../src/update/deployment-native.ts";
import { DeploymentHeld, processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import { rollbackDeployment } from "../src/update/deployment-rollback.ts";
import { rollbackFixture } from "./update-deploy-legacy-setup.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

posix(
  "controller-owned Bash rollback verifies legacy health and persists healthy rollback and active receipts",
  async () => {
    const f = await rollbackFixture();
    const original = readFileSync(f.config.monitorBootstrapFile, "utf8");
    expect(f.previousRuntime!.pid).not.toBe(f.runtime.pid);
    expect(processIdentity(f.previousRuntime!.pid)).toBeUndefined();
    expect(readRuntimeHealth(f.config)).toBeUndefined();
    await expect(captureRuntime(f.config, f.cli, true)).rejects.toThrow(DeploymentHeld);
    await expect(launchedProcess(f.config, f.cli, f.record, f.launchRequestedAt)).rejects.toThrow(DeploymentHeld);
    const rolledBack = await rollbackDeployment(f.config, f.record, f.persist);
    saveActiveDeployment(f.config, rolledBack, true);
    expect(rolledBack).toMatchObject({ status: "rolled-back", step: "done", rollbackRuntime: f.runtime });
    expect(rolledBack.rollbackHealthyAt).toBeDefined();
    expect(rolledBack.rollbackProcess).toEqual(processIdentity(f.runtime.pid));
    expect(JSON.parse(readFileSync(f.journal, "utf8"))).toMatchObject({
      status: "rolled-back",
      step: "done",
      rollbackHealthyAt: rolledBack.rollbackHealthyAt,
      rollbackRuntime: { ...f.runtime, nativeVersion: "18.18.6" },
    });
    const active = readActiveDeployment(f.config)!;
    expect(active).toMatchObject({
      source: f.record.oldSource,
      sourceHash: f.record.oldSourceHash,
      legacy: true,
      runtime: { ...f.runtime, nativeVersion: "18.18.6" },
    });
    expect(active.monitorProcesses.map(({ pid }) => pid)).toEqual(f.bootstrap.running!.map(({ pid }) => pid));
    for (const identity of active.monitorProcesses) expect(sameProcess(identity)).toBe(true);
    expect(readRuntimeHealth(f.config)).toBeUndefined();
    expect(readFileSync(f.config.monitorBootstrapFile, "utf8")).toBe(original);
    const journal = readFileSync(f.journal, "utf8");
    const completed = await observeDeploymentHealth(
      f.config,
      f.cli,
      rolledBack,
      f.record.oldSource!,
      f.launchRequestedAt,
      true,
      true,
    );
    expect(completed).toMatchObject({ ...f.runtime, nativeVersion: "18.18.6" });
    expect(rolledBack).toMatchObject({ status: "rolled-back", step: "done" });
    expect(readFileSync(f.journal, "utf8")).toBe(journal);
    expect(readFileSync(f.config.monitorBootstrapFile, "utf8")).toBe(original);
    const reentered = await rollbackDeployment(f.config, rolledBack, () => {
      throw new Error("completed rollback must not rewrite its journal");
    });
    expect(reentered).toBe(rolledBack);
    expect(reentered).toMatchObject({ status: "rolled-back", step: "done", rollbackRuntime: f.runtime });
    expect(readFileSync(f.journal, "utf8")).toBe(journal);
    expect(readFileSync(f.config.monitorBootstrapFile, "utf8")).toBe(original);
    expect(sameProcess(f.runtime)).toBe(true);
    await expect(captureRuntime(f.config, f.cli, true)).rejects.toThrow(DeploymentHeld);
    expect(existsSync(f.signalPath)).toBe(false);
  },
);

posix.each(["unregistered", "foreign", "interactive"] as const)(
  "legacy rollback keeps a real %s foreground shell held",
  async (mode) => {
    const f = await rollbackFixture({ unknown: mode === "unregistered", parentShell: mode === "interactive" });
    const foreign =
      mode === "foreign"
        ? Bun.spawn(["/bin/bash", f.script], {
            cwd: f.root,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "ignore",
          })
        : undefined;
    try {
      if (foreign) {
        const reader = foreign.stdout.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
        reader.releaseLock();
        f.front.foreground_processes.push({
          pid: foreign.pid,
          name: "bash",
          argv: procCmdline(foreign.pid).split("\0").filter(Boolean),
        });
      }
      await expect(launchedProcess(f.config, f.cli, f.record, f.launchRequestedAt, true)).rejects.toThrow(
        DeploymentHeld,
      );
      f.record.rollbackProcess = processIdentity(f.runtime.pid)!;
      await expect(
        observeDeploymentHealth(f.config, f.cli, f.record, f.record.oldSource!, f.launchRequestedAt, true, true),
      ).rejects.toThrow(DeploymentHeld);
      await expect(captureRuntime(f.config, f.cli, true)).rejects.toThrow(DeploymentHeld);
      expect(existsSync(join(f.config.releaseRoot, "active.json"))).toBe(false);
      expect(JSON.parse(readFileSync(f.journal, "utf8"))).toMatchObject({ status: "starting", step: "rollback" });
      expect(existsSync(f.signalPath)).toBe(false);
    } finally {
      if (foreign) {
        foreign.stdin.end();
        await foreign.exited;
      }
    }
  },
);

posix.each([
  "missing",
  "pid",
  "startTicks",
  "bootId",
  "imageDev",
  "imageIno",
  "launch",
  "pane",
  "role",
  "session",
  "sessionFile",
  "cwd",
  "startedAt",
  "monitor-argv",
  "monitor-cwd",
  "unknown-pid",
  "stale-health",
] as const)("legacy rollback holds a changed or absent %s receipt", async (changed) => {
  const f = await rollbackFixture();
  f.record.rollbackProcess = processIdentity(f.runtime.pid)!;
  if (changed === "missing") delete f.record.rollbackProcess;
  if (changed === "pid") f.record.rollbackProcess = { ...f.record.rollbackProcess!, pid: process.pid };
  if (["startTicks", "bootId", "imageDev", "imageIno"].includes(changed))
    f.record.rollbackProcess = { ...f.record.rollbackProcess!, [changed]: "0" };
  if (changed === "launch") f.record.rollbackLaunchRequestedAt = new Date(0).toISOString();
  if (changed === "pane") f.record.oldRuntime = { ...f.record.oldRuntime!, pane: "foreign-pane" };
  if (changed === "role") f.writeState({ role: "lane" });
  if (changed === "session") f.writeState({ sessionId: "foreign-session" });
  if (changed === "sessionFile") f.writeState({ sessionFile: join(f.root, "foreign-session.jsonl") });
  if (changed === "cwd") f.writeState({ cwd: f.config.home });
  if (changed === "startedAt") f.writeState({ startedAt: new Date(0).toISOString() });
  if (changed === "unknown-pid") f.front.foreground_processes[1]!.pid = undefined;
  if (changed === "monitor-argv")
    f.record.oldMonitors = f.record.oldMonitors!.map((monitor, index) =>
      index === 0 ? { ...monitor, argv: ["/bin/bash", join(f.root, "foreign.sh")] } : monitor,
    );
  if (changed === "monitor-cwd")
    f.record.monitors = {
      ...f.record.monitors!,
      monitors: f.record.monitors!.monitors.map((spec) => ({ ...spec, cwd: f.config.home })),
    };
  if (changed === "stale-health")
    f.writeHealth({
      ...f.health,
      pid: f.previousRuntime!.pid,
      startedAt: f.previousRuntime!.startedAt,
      updatedAt: new Date().toISOString(),
    });
  await expect(
    observeDeploymentHealth(f.config, f.cli, f.record, f.record.oldSource!, f.launchRequestedAt, true, true),
  ).rejects.toThrow(DeploymentHeld);
  expect(existsSync(join(f.config.releaseRoot, "active.json"))).toBe(false);
  expect(existsSync(f.signalPath)).toBe(false);
});

posix.each(["startTicks", "bootId", "imageDev", "imageIno"] as const)(
  "legacy rollback never reuses a stale shell %s receipt",
  async (field) => {
    const f = await rollbackFixture();
    const expected = await launchedProcess(f.config, f.cli, f.record, f.launchRequestedAt, true);
    expect(expected).toBeDefined();
    f.record.rollbackProcess = expected!;
    const receipt = legacyRollbackForeground(f.config, f.record, f.launchRequestedAt, expected!);
    const stale = {
      ...receipt,
      running: receipt.running.map((monitor, index) => (index === 0 ? { ...monitor, [field]: "0" } : monitor)),
    };
    await expect(captureRuntime(f.config, f.cli, true, undefined, stale)).rejects.toThrow(DeploymentHeld);
    expect(existsSync(join(f.config.releaseRoot, "active.json"))).toBe(false);
    expect(existsSync(f.signalPath)).toBe(false);
  },
);

posix.each([
  "status",
  "step",
  "healthy-at",
  "process",
  "runtime",
  "foreign-process",
  "foreign-session",
  "source",
  "old-live",
] as const)("completed legacy rollback observation holds a missing or foreign %s receipt", async (changed) => {
  const f = await rollbackFixture();
  const rolledBack = await rollbackDeployment(f.config, f.record, f.persist);
  const journal = readFileSync(f.journal, "utf8");
  const bootstrap = readFileSync(f.config.monitorBootstrapFile, "utf8");
  if (changed === "status") rolledBack.status = "starting";
  if (changed === "step") rolledBack.step = "rollback";
  if (changed === "healthy-at") delete rolledBack.rollbackHealthyAt;
  if (changed === "process") delete rolledBack.rollbackProcess;
  if (changed === "runtime") delete rolledBack.rollbackRuntime;
  if (changed === "foreign-process") rolledBack.rollbackProcess = { ...rolledBack.rollbackProcess!, pid: process.pid };
  if (changed === "foreign-session")
    rolledBack.rollbackRuntime = { ...rolledBack.rollbackRuntime!, sessionId: "foreign-session" };
  if (changed === "source") rolledBack.oldSourceHash = "0".repeat(64);
  if (changed === "old-live") rolledBack.oldRuntime = f.runtime;
  await expect(
    observeDeploymentHealth(f.config, f.cli, rolledBack, f.record.oldSource!, f.launchRequestedAt, true, true),
  ).rejects.toThrow(DeploymentHeld);
  if (changed !== "status" && changed !== "step") {
    await expect(
      rollbackDeployment({ ...f.config, healthTimeoutMs: 50 }, rolledBack, () => {
        throw new Error("completed rollback must not rewrite its journal");
      }),
    ).rejects.toThrow(DeploymentHeld);
    expect(rolledBack).toMatchObject({ status: "rolled-back", step: "done" });
  }
  expect(readFileSync(f.journal, "utf8")).toBe(journal);
  expect(readFileSync(f.config.monitorBootstrapFile, "utf8")).toBe(bootstrap);
  expect(sameProcess(f.runtime)).toBe(true);
  expect(existsSync(f.signalPath)).toBe(false);
});
