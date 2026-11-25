import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployRelease } from "../src/update/deployment.ts";
import { readActiveDeployment } from "../src/update/deployment-active.ts";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { captureRuntime } from "../src/update/deployment-harness.ts";
import { readRuntimeHealth } from "../src/update/deployment-monitor-receipts.ts";
import { currentHealth, currentReceipt, currentRecord } from "../src/update/deployment-previous-main.ts";
import { managedOmpCommand, sameProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord, ToolchainReceipt } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { headlessDeployment } from "./update-deploy-headless-setup.ts";

// The headless harness needs a Unix socket and the process readers that bind deployment identity.
const native = test.skipIf(process.platform !== "linux");
// POSIX-only: the health reader requires an owner-only file of this user, which Windows modes cannot express.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The receipt the previous main's controller recorded: its extension pinned through the `ompUlw` overlay. */
function previousReceipt(toolchain: ToolchainReceipt, source: string): Record<string, unknown> {
  const { extensionSource: _pinned, ...rest } = toolchain;
  return { ...rest, ompUlw: { source, identity: "c".repeat(64), directory: join(source, "..", "omp-ulw") } };
}

const receipt: ToolchainReceipt = {
  omp: "/private/omp",
  bun: "/private/bun",
  nativeVersion: "19.0.1",
  ompEntry: "/private/omp-entry",
  ompEntryHash: "a".repeat(64),
  bunHash: "b".repeat(64),
  nativeConfig: "/releases/native-config.json",
  nativeConfigHash: "d".repeat(64),
  nativeOverride: true,
  extensionSource: "/releases/new",
};

test("the previous main's health and receipts read in the current shape; others stay as written", () => {
  const health = { version: 1, role: "cataly", presetLoaded: false, pid: 7 };
  expect(currentHealth(health)).toEqual({ version: 1, role: "cataly", configLoaded: false, pid: 7 });
  const current = { version: 1, role: "cataly", configLoaded: true };
  expect(currentHealth(current)).toBe(current);
  // Not the previous main's shape: ordinary validation still sees, and holds on, the value as written.
  for (const other of [{ presetLoaded: "yes" }, { presetLoaded: true, configLoaded: true }, null, []])
    expect(currentHealth(other)).toBe(other);

  const previous = previousReceipt(receipt, "/releases/old") as unknown as ToolchainReceipt;
  const converted = currentReceipt(previous);
  expect(converted).toEqual({ ...receipt, extensionSource: "/releases/old" });
  // The old controller launched exactly this command for a receipt with its overlay pinned to that source.
  expect(managedOmpCommand(converted, "/releases/old")).toEqual([
    "/private/omp",
    "--config",
    "/releases/native-config.json",
    "--no-extensions",
    "-e",
    join("/releases/old", "extension"),
  ]);
  expect(currentReceipt(receipt)).toBe(receipt);
  // A receipt that pinned no extension at all keeps holding: its launch discovered extensions globally.
  const { extensionSource: _source, ...unpinned } = receipt;
  const bare = unpinned as unknown as ToolchainReceipt;
  expect(currentReceipt(bare)).toBe(bare);
  expect(() => managedOmpCommand(bare, "/releases/old")).toThrow(
    "managed extension source differs from its prepared toolchain",
  );

  const journal = { id: "t", toolchain: receipt, oldToolchain: previous } as unknown as DeploymentRecord;
  expect(currentRecord(journal)).toEqual({ ...journal, oldToolchain: converted });
  const unchanged = { id: "t", toolchain: receipt } as unknown as DeploymentRecord;
  expect(currentRecord(unchanged)).toBe(unchanged);
});

posix("a lead health file the previous main wrote reads as current health", () => {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "cataly-previous-health-")));
  roots.push(stateDir);
  const pane = "headless:lead";
  mkdirSync(join(stateDir, "runtime"));
  const now = new Date().toISOString();
  const shared = {
    version: 1 as const,
    monitors: [],
    paneId: pane,
    sessionId: "session",
    role: "cataly",
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    source: "/releases/old",
    extensionHash: "e".repeat(64),
  };
  writeFileSync(
    join(stateDir, "runtime", `${encodeURIComponent(pane)}.json`),
    JSON.stringify({ ...shared, presetLoaded: true }),
    { mode: 0o600 },
  );
  expect(readRuntimeHealth({ stateDir, pane, sessionId: "session" })).toEqual({ ...shared, configLoaded: true });
});

/** A previous-main lead with the active receipt its controller wrote. */
async function previousMainDeployment(healthy?: (source: string) => boolean) {
  const f = await headlessDeployment({ previousMain: true, ...(healthy ? { healthy } : {}) });
  const runtime = await captureRuntime(f.config, true);
  saveDeploymentJson(join(f.config.releaseRoot, "active.json"), {
    version: 1,
    configHash: digest(JSON.stringify(f.config)),
    source: f.oldSource,
    sourceHash: sourceManifest(f.oldSource).hash,
    runtime,
    monitorProcesses: [],
    toolchain: previousReceipt(f.toolchain, f.oldSource),
  });
  /** The raw health file the lead with reservation `ref` writes. */
  const health = (ref: string) =>
    JSON.parse(readFileSync(join(f.config.stateDir, "runtime", `${encodeURIComponent(ref)}.json`), "utf8"));
  return { ...f, health };
}

native(
  "a lead the previous main started is stopped, switched and resumed on this version with no manual step",
  async () => {
    const f = await previousMainDeployment();
    try {
      const old = (await f.lead())!;
      const before = f.health(old.ref.id);
      expect(before.presetLoaded).toBe(true);
      expect(before.configLoaded).toBeUndefined();
      const result = await deployRelease(f.config, f.input, f.record, () => {});
      expect(result).toMatchObject({ status: "healthy", step: "done", oldSource: f.oldSource });
      expect(result.error).toBeUndefined();
      expect(result.oldToolchain).toEqual({ ...f.toolchain, extensionSource: f.oldSource });
      expect(realpathSync(f.config.liveSource)).toBe(f.newSource);
      const lead = (await f.lead())!;
      expect(lead.pid).not.toBe(old.pid);
      expect(sameProcess(result.oldRuntime!)).toBe(false);
      // The new release's `harness up` resumed the very session the previous main's lead ran.
      expect(lead.sessionId).toBe(old.sessionId);
      expect(result.runtime).toMatchObject({ pid: lead.pid, sessionId: old.sessionId });
      const active = JSON.parse(readFileSync(join(f.config.releaseRoot, "active.json"), "utf8"));
      expect(active.toolchain.extensionSource).toBe(f.newSource);
      expect(active.toolchain.ompUlw).toBeUndefined();
      expect(f.health(lead.ref.id).configLoaded).toBe(true);
    } finally {
      await f.teardown();
    }
  },
  120_000,
);

native(
  "a failed start rolls back to the previous main's lead and session through its own receipt",
  async () => {
    let next = "";
    const f = await previousMainDeployment((source) => source !== next);
    next = f.newSource;
    try {
      const old = (await f.lead())!;
      const result = await deployRelease(f.config, f.input, f.record, () => {});
      expect(result).toMatchObject({ status: "rolled-back", step: "done" });
      expect(result.error).toBe("native lead code health has not converged on its source");
      expect(result.rollbackError).toBeUndefined();
      expect(realpathSync(f.config.liveSource)).toBe(f.oldSource);
      const lead = (await f.lead())!;
      expect(lead.sessionId).toBe(old.sessionId);
      expect(sameProcess(result.rollbackRuntime!)).toBe(true);
      expect(readActiveDeployment(f.config)).toMatchObject({
        source: f.oldSource,
        toolchain: { extensionSource: f.oldSource },
      });
      // The restored lead runs the previous main again and writes its health shape.
      expect(f.health(lead.ref.id).presetLoaded).toBe(true);
    } finally {
      await f.teardown();
    }
  },
  120_000,
);
