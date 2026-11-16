import { expect, test } from "bun:test";
import { procCmdline } from "../src/update/proc.ts";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readActiveDeployment } from "../src/update/deployment-active.ts";
import { captureStartedMonitors } from "../src/update/deployment-handoff.ts";
import { observeDeploymentHealth } from "../src/update/deployment-health.ts";
import { launchedProcess, launchRuntime, stopLaunchedProcess } from "../src/update/deployment-launch.ts";
import { nativeCli, requireShell } from "../src/update/deployment-native.ts";
import { DeploymentHeld, processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import { restartDeployment } from "../src/update/deployment-restart.ts";
import { waitLaunchedProcess } from "../src/update/deployment-rollback.ts";
import { foregroundCli } from "./update-deploy-foreground-cli.ts";
import { managedBashFixture } from "./update-deploy-managed-setup.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

posix("a managed Bash launch journals its real actor, verifies health and becomes active", async () => {
  const f = await managedBashFixture();
  expect((await f.cli.probe(f.config.pane, "held", f.config.stateDir)).shellInFront).toBe(true);
  const healthy = await restartDeployment(f.config);
  expect(healthy).toMatchObject({
    status: "healthy",
    step: "done",
    launchProcess: processIdentity(f.runtime.pid),
    runtime: { ...f.runtime, nativeVersion: "18.18.8", busy: false, approvalPending: false },
  });
  expect(JSON.parse(readFileSync(f.journal, "utf8"))).toMatchObject({
    status: "healthy",
    launchProcess: healthy.launchProcess,
    runtime: healthy.runtime,
  });
  const active = readActiveDeployment(f.config)!;
  expect(active).toMatchObject({ legacy: false, sourceHash: f.record.sourceHash, runtime: healthy.runtime });
  expect(active.monitorProcesses.map(({ pid }) => pid)).toEqual(f.health.monitors.map(({ pid }) => pid));
  for (const monitor of active.monitorProcesses) expect(sameProcess(monitor)).toBe(true);
  expect(existsSync(f.effect)).toBe(false);
  expect(existsSync(f.signalPath)).toBe(false);
});

posix("a prior managed Bash actor resumes rollback with managed health and an active receipt", async () => {
  const f = await managedBashFixture();
  f.record.step = "rollback";
  f.record.rollbackRequestedAt = f.launchRequestedAt;
  f.record.rollbackLaunchRequestedAt = f.launchRequestedAt;
  f.persist(f.record);
  const restored = await restartDeployment(f.config);
  expect(restored).toMatchObject({
    status: "rolled-back",
    step: "done",
    rollbackProcess: processIdentity(f.runtime.pid),
    rollbackRuntime: { ...f.runtime, nativeVersion: "18.18.8" },
  });
  expect(JSON.parse(readFileSync(f.journal, "utf8"))).toMatchObject({
    status: "rolled-back",
    rollbackHealthyAt: restored.rollbackHealthyAt,
    rollbackProcess: restored.rollbackProcess,
  });
  expect(readActiveDeployment(f.config)).toMatchObject({ legacy: false, runtime: restored.rollbackRuntime });
  expect(existsSync(f.effect)).toBe(false);
  expect(existsSync(f.signalPath)).toBe(false);
});

posix("a failed managed Bash health check still permits an owned idle startup to stop", async () => {
  const f = await managedBashFixture();
  const expected = await waitLaunchedProcess(f.config, f.record, f.launchRequestedAt);
  expect(expected).toEqual(processIdentity(f.runtime.pid));
  f.record.launchProcess = expected!;
  f.writeHealth({ ...f.health, presetLoaded: false });
  await expect(
    observeDeploymentHealth(f.config, f.cli, f.record, f.record.releasePath, f.launchRequestedAt),
  ).rejects.toThrow(DeploymentHeld);
  f.record.runtimeMonitors = captureStartedMonitors(f.config, f.record);
  f.persist(f.record);
  await stopLaunchedProcess(f.config, f.cli, f.record, f.launchRequestedAt, expected!);
  expect(sameProcess(expected!)).toBe(false);
  for (const monitor of f.record.runtimeMonitors) expect(sameProcess(monitor)).toBe(false);
  expect(readFileSync(f.signalPath, "utf8")).toBe("SIGTERM");
  await requireShell(f.config, f.cli);
});

posix("launchRuntime executes once through a positively bare root Bash prompt", async () => {
  const f = await managedBashFixture();
  const expected = await launchedProcess(f.config, f.cli, f.record, f.launchRequestedAt);
  await stopLaunchedProcess(f.config, f.cli, f.record, f.launchRequestedAt, expected!);
  const starts = join(f.root, "starts");
  const before = readFileSync(starts, "utf8").trim().split("\n");
  const cli = foregroundCli(f.config, f.observe, f.sendLine);
  const watcher = watch(starts);
  try {
    const changed = once(watcher, "change");
    await launchRuntime(f.config, cli, f.record);
    await changed;
    const after = readFileSync(starts, "utf8").trim().split("\n");
    expect(after).toHaveLength(before.length + 1);
    expect(processIdentity(Number(after.at(-1)))).toBeDefined();
    await expect(requireShell(f.config, cli)).rejects.toThrow(DeploymentHeld);
  } finally {
    watcher.close();
  }
});

posix.each([
  "unknown",
  "subshell",
  "interactive",
  "stale",
  "reused",
  "foreign",
  "busy",
  "approval",
  "config",
  "entry",
] as const)("managed Bash startup cleanup holds a real %s boundary without a signal", async (mode) => {
  const f = await managedBashFixture({
    unknown: mode === "unknown",
    subshell: mode === "subshell",
    parentShell: mode === "interactive",
    paneShell: mode !== "interactive",
  });
  const foreign =
    mode === "foreign"
      ? Bun.spawn(["/bin/bash", f.script], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
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
    if (mode === "stale") f.writeHealth({ ...f.health, pid: f.previousRuntime!.pid });
    if (mode === "busy") f.writeState({ agentStatus: "working" });
    if (mode === "approval") f.writeState({ approvalPending: true });
    if (mode === "config") writeFileSync(f.record.toolchain!.nativeConfig, "{}");
    if (mode === "entry") appendFileSync(f.config.omp, "\n");
    const expected = { ...processIdentity(f.runtime.pid)!, ...(mode === "reused" ? { startTicks: "0" } : {}) };
    f.record.launchProcess = expected;
    f.writeObservation();
    await expect(
      stopLaunchedProcess(f.config, nativeCli(f.config), f.record, f.launchRequestedAt, expected),
    ).rejects.toThrow(DeploymentHeld);
    expect(sameProcess(f.runtime)).toBe(true);
    for (const monitor of f.bootstrap.running!) expect(sameProcess(monitor.identity!)).toBe(true);
    expect(existsSync(f.signalPath)).toBe(false);
    expect(existsSync(f.effect)).toBe(false);
  } finally {
    if (foreign) {
      foreign.stdin.end();
      await foreign.exited;
    }
  }
});
