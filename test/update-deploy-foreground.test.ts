import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureRuntime } from "../src/update/deployment-native.ts";
import { DeploymentBusy, DeploymentHeld, processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord, MonitorSet, RuntimeIdentity } from "../src/update/deployment-types.ts";
import { foregroundFixture } from "./update-deploy-foreground-setup.ts";

function untouched(f: { runtime: RuntimeIdentity; bootstrap: MonitorSet; signalPath: string }): void {
  expect(sameProcess(f.runtime)).toBe(true);
  for (const monitor of f.bootstrap.running!) expect(sameProcess(monitor.identity!)).toBe(true);
  expect(existsSync(f.signalPath)).toBe(false);
}

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");
const linux = test.skipIf(process.platform !== "linux");
posix("capture admits Bash scripts beside Bun wrapper execs while the generic probe holds", async () => {
  const f = await foregroundFixture();
  expect((await f.cli.probe(f.config.pane, "held", f.config.stateDir)).shellInFront).toBe(true);
  expect(await captureRuntime(f.config, f.cli)).toMatchObject({ ...f.runtime, busy: false, approvalPending: false });
  untouched(f);
});

posix.each(["argv", "cwd"] as const)("an attested shell still requires its declared %s", async (changed) => {
  const f = await foregroundFixture();
  f.writeBootstrap({
    ...f.bootstrap,
    monitors: f.bootstrap.monitors.map((spec, index) =>
      index === 0
        ? {
            ...spec,
            ...(changed === "argv" ? { argv: [join(f.root, "unknown.sh")] } : { cwd: f.config.home }),
          }
        : spec,
    ),
  });
  await expect(captureRuntime(f.config, f.cli, true)).rejects.toThrow(DeploymentHeld);
  untouched(f);
});

posix.each(["native", "group", "pid", "runtime", "monitor"] as const)(
  "foreground exception requires complete group and bootstrap attestation: %s",
  async (missing) => {
    const f = await foregroundFixture();
    if (missing === "native")
      f.front.foreground_processes = f.front.foreground_processes.filter(({ pid }) => pid !== f.runtime.pid);
    if (missing === "group") f.front.foreground_process_group_id = undefined;
    if (missing === "pid") f.front.foreground_processes[1]!.pid = undefined;
    if (missing === "runtime") {
      const bootstrap = { ...f.bootstrap };
      delete bootstrap.runtime;
      f.writeBootstrap(bootstrap);
    }
    if (missing === "monitor")
      f.writeBootstrap({
        ...f.bootstrap,
        running: f.bootstrap.running!.map(({ name, pid }) => ({ name, pid })),
      });
    await expect(captureRuntime(f.config, f.cli, true)).rejects.toThrow(DeploymentHeld);
    untouched(f);
  },
);

posix.each([
  ["native", "startTicks"],
  ["native", "bootId"],
  ["native", "imageIno"],
  ["monitor", "startTicks"],
  ["monitor", "bootId"],
  ["monitor", "imageIno"],
] as const)("saved %s incarnation rejects a reused or changed %s", async (target, field) => {
  const f = await foregroundFixture();
  f.writeBootstrap(
    target === "native"
      ? { ...f.bootstrap, runtime: { ...f.bootstrap.runtime!, [field]: "0" } }
      : {
          ...f.bootstrap,
          running: f.bootstrap.running!.map((entry) => ({
            ...entry,
            identity: { ...entry.identity!, [field]: "0" },
          })),
        },
  );
  await expect(captureRuntime(f.config, f.cli, true)).rejects.toThrow(DeploymentHeld);
  untouched(f);
});

posix("an unregistered foreground script under the native PID remains held", async () => {
  const f = await foregroundFixture({ unknown: true });
  await expect(captureRuntime(f.config, f.cli, true)).rejects.toThrow(DeploymentHeld);
  untouched(f);
});

// macOS /bin/bash 3.2 gives an interactive shell's children their own process group, so the fixture cannot build this group.
linux("a real interactive parent shell in the native foreground group remains held", async () => {
  const f = await foregroundFixture({ parentShell: true });
  expect(f.front.foreground_processes[0]!.name).toBe("bash");
  expect(f.front.foreground_process_group_id).toBe(f.front.shell_pid);
  await expect(captureRuntime(f.config, f.cli, true)).rejects.toThrow(DeploymentHeld);
  untouched(f);
});

posix.each(["foreign", "exited"] as const)("a %s script PID receipt never discounts an owned shell", async (mode) => {
  const f = await foregroundFixture();
  const foreign = Bun.spawn(["/bin/bash", f.script], {
    cwd: f.root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const reader = foreign.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    reader.releaseLock();
    const identity = processIdentity(foreign.pid)!;
    if (mode === "exited") {
      foreign.stdin.end();
      await foreign.exited;
    }
    f.writeBootstrap({
      ...f.bootstrap,
      running: f.bootstrap.running!.map((entry, index) =>
        index === 0 ? { ...entry, pid: foreign.pid, identity } : entry,
      ),
    });
    await expect(captureRuntime(f.config, f.cli, true)).rejects.toThrow(DeploymentHeld);
    untouched(f);
  } finally {
    if (foreign.exitCode === null) foreign.stdin.end();
    await foreign.exited;
  }
});

posix("managed capture uses current health and desired monitors rather than old bootstrap IDs", async () => {
  const f = await foregroundFixture();
  f.writeHealth();
  f.writeBootstrap({ ...f.bootstrap, runtime: { ...f.bootstrap.runtime!, startTicks: "0" } });
  expect(await captureRuntime(f.config, f.cli)).toMatchObject(f.runtime);
  untouched(f);
});

posix.each(["pid", "startTicks", "session", "startedAt", "spec"] as const)(
  "managed monitor attestation holds mismatched %s without bootstrap fallback",
  async (changed) => {
    const f = await foregroundFixture();
    const health = {
      ...f.health,
      ...(changed === "session" ? { sessionId: "foreign-session" } : {}),
      ...(changed === "startedAt" ? { startedAt: new Date(Date.parse(f.runtime.startedAt) - 1).toISOString() } : {}),
      monitors: f.health.monitors.map((monitor) => ({
        ...monitor,
        ...(changed === "pid" ? { pid: process.pid } : {}),
        ...(changed === "startTicks" ? { startTicks: "0" } : {}),
        ...(changed === "spec" ? { filter: "different" } : {}),
      })),
    };
    f.writeHealth(health);
    await expect(captureRuntime(f.config, f.cli, true)).rejects.toThrow(DeploymentHeld);
    untouched(f);
  },
);

posix("attested foreground monitors preserve the busy and explicit quiesce boundaries", async () => {
  const f = await foregroundFixture();
  f.writeState({ agentStatus: "working" });
  await expect(captureRuntime(f.config, f.cli)).rejects.toThrow(DeploymentBusy);
  expect(await captureRuntime(f.config, f.cli, true)).toMatchObject({ busy: true, approvalPending: false });
  const record: DeploymentRecord = {
    version: 1,
    id: "foreground-quiesce",
    inputHash: "input",
    configHash: "config",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: "c".repeat(64),
    releasePath: f.root,
    directory: f.root,
    createdAt: f.runtime.startedAt,
    status: "prepared",
    step: "prepare",
  };
  writeFileSync(
    f.config.quiesceCheckpointFile,
    JSON.stringify({
      version: 1,
      deploymentId: record.id,
      commit: record.commit,
      sourceHash: record.sourceHash,
      pane: f.runtime.pane,
      sessionId: f.runtime.sessionId,
      pid: f.runtime.pid,
      startTicks: f.runtime.startTicks,
      bootId: f.runtime.bootId,
      startedAt: f.runtime.startedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { mode: 0o600 },
  );
  expect(await captureRuntime(f.config, f.cli, false, record)).toMatchObject({ busy: true });
  expect(record.quiesceHash).toBeDefined();
  expect(existsSync(f.config.quiesceCheckpointFile)).toBe(true);
  untouched(f);
});

posix("attested foreground monitors never clear a native approval", async () => {
  const f = await foregroundFixture();
  f.writeState({ approvalPending: true });
  await expect(captureRuntime(f.config, f.cli)).rejects.toThrow(DeploymentHeld);
  expect(await captureRuntime(f.config, f.cli, true)).toMatchObject({ approvalPending: true });
  untouched(f);
});
