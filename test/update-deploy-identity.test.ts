import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import { ownReleaseRoot, saveDeploymentJson } from "../src/update/deployment-files.ts";
import { readMonitorSet } from "../src/update/deployment-monitors.ts";
import { monitorProcessReceipts } from "../src/update/deployment-monitor-receipts.ts";
import { processIdentity } from "../src/update/deployment-process.ts";
import { consumeQuiesceCheckpoint, verifyQuiesceCheckpoint } from "../src/update/deployment-quiesce.ts";
import {
  deferRestartIntent,
  finishRestartIntent,
  readRestartIntent,
  saveRestartIntent,
} from "../src/update/deployment-restart-state.ts";
import type { DeploymentRecord, RuntimeHealth, RuntimeIdentity } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");
// POSIX-only: the quiesce checkpoint asserts a 0o600 file mode, which Windows does not model.
const it = test.skipIf(process.platform === "win32");

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cataly-deploy-identity-"));
  directories.push(root);
  const config = parseDeploymentConfig(
    {
      releaseRoot: "managed",
      liveSource: "home/.cataly/src",
      home: "home",
      catalyHome: "home/.cataly",
      catalyConfig: "home/.cataly/config.json",
      stateDir: "home/.cataly/state",
      bun: process.execPath,
      omp: process.execPath,
      restartLock: "home/.cataly/restart.lock",
      launcherPath: "home/.cataly/bin/restart",
      healthTimeoutMs: 100,
      quiesceCheckpointFile: "quiesce.json",
    },
    root,
  );
  const runtime: RuntimeIdentity = {
    ...processIdentity(process.pid)!,
    role: "cataly",
    ref: "00000000-0000-4000-8000-000000000001",
    sessionId: "same-session",
    sessionFile: join(root, "existing-session.jsonl"),
    startedAt: new Date().toISOString(),
    cwd: root,
  };
  const record: DeploymentRecord = {
    version: 1,
    id: "intended-deployment",
    inputHash: "input",
    configHash: "config",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: "c".repeat(64),
    releasePath: join(root, "release"),
    directory: join(root, "transaction"),
    createdAt: new Date().toISOString(),
    status: "prepared",
    step: "prepare",
  };
  const checkpoint = {
    version: 1,
    deploymentId: record.id,
    commit: record.commit,
    sourceHash: record.sourceHash,
    ref: runtime.ref,
    sessionId: runtime.sessionId,
    pid: runtime.pid,
    startTicks: runtime.startTicks,
    bootId: runtime.bootId,
    startedAt: runtime.startedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { root, config, runtime, record, checkpoint };
}

it("one initial quiesce checkpoint binds the exact intent and process incarnation", () => {
  const f = fixture();
  expect(() => verifyQuiesceCheckpoint(f.config, f.record, f.runtime)).toThrow();
  writeFileSync(f.config.quiesceCheckpointFile!, JSON.stringify(f.checkpoint), { mode: 0o600 });
  verifyQuiesceCheckpoint(f.config, f.record, f.runtime);
  expect(f.record.quiesceHash).toMatch(/^[a-f0-9]{64}$/);
  f.record.oldRuntime = f.runtime;
  verifyQuiesceCheckpoint(f.config, f.record, f.runtime);
  expect(() =>
    verifyQuiesceCheckpoint(f.config, f.record, { ...f.runtime, startTicks: `${BigInt(f.runtime.startTicks) + 1n}` }),
  ).toThrow();
  expect(() => verifyQuiesceCheckpoint(f.config, { ...f.record, id: "other-deployment" }, f.runtime)).toThrow();
  expect(() => verifyQuiesceCheckpoint(f.config, { ...f.record, commit: "d".repeat(40) }, f.runtime)).toThrow();
});

it("a consumed checkpoint resumes its own journal and never admits a later deployment", () => {
  const f = fixture();
  writeFileSync(f.config.quiesceCheckpointFile!, JSON.stringify(f.checkpoint), { mode: 0o600 });
  verifyQuiesceCheckpoint(f.config, f.record, f.runtime);
  consumeQuiesceCheckpoint(f.config, f.record);
  expect(lstatSync(f.config.quiesceCheckpointFile!, { throwIfNoEntry: false })).toBeUndefined();
  verifyQuiesceCheckpoint(f.config, f.record, f.runtime);
  const nextRecord = { ...f.record, id: "next-deployment" };
  delete nextRecord.quiesceHash;
  expect(() => verifyQuiesceCheckpoint(f.config, nextRecord, f.runtime)).toThrow();
});

it("expired, altered and public checkpoints never admit an actor that became busy later", () => {
  const f = fixture();
  writeFileSync(
    f.config.quiesceCheckpointFile!,
    JSON.stringify({ ...f.checkpoint, expiresAt: new Date(Date.now() - 1).toISOString() }),
    { mode: 0o600 },
  );
  expect(() => verifyQuiesceCheckpoint(f.config, f.record, f.runtime)).toThrow();
  writeFileSync(f.config.quiesceCheckpointFile!, JSON.stringify(f.checkpoint));
  chmodSync(f.config.quiesceCheckpointFile!, 0o644);
  expect(() => verifyQuiesceCheckpoint(f.config, f.record, f.runtime)).toThrow();
  chmodSync(f.config.quiesceCheckpointFile!, 0o600);
  expect(() =>
    verifyQuiesceCheckpoint(f.config, f.record, { ...f.runtime, startedAt: new Date(0).toISOString() }),
  ).toThrow();
  verifyQuiesceCheckpoint(f.config, f.record, f.runtime);
  writeFileSync(
    f.config.quiesceCheckpointFile!,
    JSON.stringify({ ...f.checkpoint, expiresAt: new Date(Date.now() + 30_000).toISOString() }),
  );
  expect(() => verifyQuiesceCheckpoint(f.config, f.record, f.runtime)).toThrow();
});

posix("monitor receipts bind a real descendant of the lead and reject the actor itself", async () => {
  const f = fixture();
  const path = join(f.root, "monitors.json");
  const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  try {
    // A trusted bootstrap receipt parses for the extension's bootstrap reader.
    const metadata = {
      version: 1,
      sessionId: f.runtime.sessionId,
      monitors: [{ name: "intake", argv: ["sleep", "60"], filter: ".", cwd: f.root }],
      running: [{ name: "intake", pid: child.pid }],
      intake: { path: join(f.root, "heartbeat"), monitor: "intake", maxAgeMs: 120_000 },
      runtime: { ...f.runtime, pane: "w1:p1", role: "cataly" },
    };
    writeFileSync(path, JSON.stringify(metadata), { mode: 0o600 });
    const wanted = readMonitorSet(path, f.runtime.sessionId, true);
    expect(wanted.runtime?.role).toBe("cataly");
    expect(() => readMonitorSet(path, "other-session", true)).toThrow();
    const startTicks = processIdentity(child.pid)!.startTicks;
    const health: RuntimeHealth = {
      version: 1,
      paneId: f.runtime.ref,
      pid: f.runtime.pid,
      sessionId: f.runtime.sessionId,
      role: "cataly",
      configLoaded: true,
      startedAt: f.runtime.startedAt,
      updatedAt: new Date().toISOString(),
      source: f.root,
      extensionHash: "e".repeat(64),
      monitors: [{ ...wanted.monitors[0]!, pid: child.pid, startTicks }],
    };
    const receipts = monitorProcessReceipts(f.runtime, health);
    expect(receipts[0]?.pid).toBe(child.pid);
    expect(receipts[0]?.startTicks).toBe(startTicks);
    expect(() =>
      monitorProcessReceipts(f.runtime, {
        ...health,
        monitors: [{ ...wanted.monitors[0]!, pid: process.pid, startTicks: f.runtime.startTicks }],
      }),
    ).toThrow();
    expect(() => monitorProcessReceipts(f.runtime, { ...health, sessionId: "other-session" })).toThrow();
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
});

test("an interrupted restart retains its owner and archives only a verified terminal state", () => {
  const f = fixture();
  ownReleaseRoot(f.config);
  const id = "restart-abcd";
  const record: DeploymentRecord = {
    ...f.record,
    id,
    configHash: digest(JSON.stringify(f.config)),
    directory: join(f.config.releaseRoot, "transactions", id),
    oldRuntime: f.runtime,
    status: "stopping",
    step: "stop",
  };
  saveRestartIntent(f.config, record);
  expect(readRestartIntent(f.config)?.oldRuntime?.startTicks).toBe(f.runtime.startTicks);
  expect(() => readRestartIntent({ ...f.config, healthTimeoutMs: 200 })).toThrow("intent differs");
  expect(() => finishRestartIntent(f.config, { ...record, status: "healthy", step: "done" })).toThrow();
  expect(readRestartIntent(f.config)?.step).toBe("stop");
  record.status = "starting";
  record.step = "health";
  record.launchRequestedAt = new Date().toISOString();
  saveRestartIntent(f.config, record);
  expect(readRestartIntent(f.config)?.oldRuntime?.pid).toBe(f.runtime.pid);
  expect(readRestartIntent(f.config)?.step).toBe("health");
  record.status = "healthy";
  record.step = "done";
  record.runtime = f.runtime;
  saveRestartIntent(f.config, record);
  finishRestartIntent(f.config, record);
  expect(readRestartIntent(f.config)).toBeUndefined();
  expect(lstatSync(join(record.directory, "completed-intent.json")).isFile()).toBe(true);
  const unrelated = join(f.root, "outside");
  saveDeploymentJson(join(f.config.releaseRoot, "restart-pending.json"), {
    id,
    directory: unrelated,
    configHash: record.configHash,
  });
  expect(() => readRestartIntent(f.config)).toThrow();
  expect(lstatSync(unrelated, { throwIfNoEntry: false })).toBeUndefined();
});

test("a pre-stop busy restart can defer its intent while any recorded stop remains pending", () => {
  const f = fixture();
  ownReleaseRoot(f.config);
  const id = "restart-cafe";
  const record: DeploymentRecord = {
    ...f.record,
    id,
    configHash: digest(JSON.stringify(f.config)),
    directory: join(f.config.releaseRoot, "transactions", id),
    oldRuntime: f.runtime,
    status: "held",
    step: "stop",
  };
  saveRestartIntent(f.config, record);
  deferRestartIntent(f.config, record);
  expect(readRestartIntent(f.config)).toBeUndefined();
  expect(lstatSync(join(record.directory, "deferred-intent.json")).isFile()).toBe(true);
  record.stopRequestedAt = new Date().toISOString();
  saveRestartIntent(f.config, record);
  expect(() => deferRestartIntent(f.config, record)).toThrow();
  expect(readRestartIntent(f.config)?.stopRequestedAt).toBe(record.stopRequestedAt);
});
