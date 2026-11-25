import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform } from "../src/platform/index.ts";
import { ownReleaseRoot, saveDeploymentJson } from "../src/update/deployment-files.ts";
import { acquireRestartLock, DeploymentHeld } from "../src/update/deployment-process.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { applySourceUpdate, restartSourceLead } from "../src/update/source-update-run.ts";
import {
  parseSourceState,
  readSourceState,
  saveSourceState,
  sourceRecoveryPending,
  type SourceJob,
} from "../src/update/source-update-state.ts";
import { sourceFixture } from "./update-source-setup.ts";

function stateFixture() {
  const f = sourceFixture();
  const config = f.config.deployment;
  const manifest = sourceManifest(config.liveSource);
  const commit = "c".repeat(40),
    tree = "d".repeat(40);
  const input = {
    remote: `https://github.com/${f.config.repository}.git`,
    commit,
    tree,
    candidate: join(config.releaseRoot, "source-candidates", commit),
    sourceHash: manifest.hash,
    publicManifest: manifest,
  };
  const id = "source-state-fixture";
  const deployment: DeploymentRecord = {
    version: 1,
    id,
    inputHash: digest(JSON.stringify(input)),
    configHash: digest(JSON.stringify(config)),
    commit,
    tree,
    sourceHash: manifest.hash,
    releasePath: join(config.releaseRoot, "releases", `${commit}-${manifest.hash.slice(0, 16)}`),
    directory: join(config.releaseRoot, "transactions", id),
    createdAt: new Date().toISOString(),
    status: "prepared",
    step: "prepare",
  };
  const job: SourceJob = {
    createdAt: deployment.createdAt,
    repository: f.config.repository,
    deploymentConfigHash: deployment.configHash,
    current: { path: config.liveSource, commit: "a".repeat(40), tree: "b".repeat(40), sourceHash: manifest.hash },
    target: { commit, tree, main: commit, ahead: 1, ci: { id: 70, attempt: 2 } },
    input,
    deployment,
  };
  return {
    ...f,
    job,
    deployment,
    state: { version: 1 as const, job },
    statePath: join(config.releaseRoot, "source-update.json"),
  };
}

const posixJournal = test.skipIf(!platform.posixOwnership);

test("absent source status is read-only", () => {
  const f = stateFixture();
  expect(readSourceState(f.config)).toEqual({ version: 1 });
  expect(existsSync(f.config.deployment.releaseRoot)).toBe(false);
});

posixJournal("saved intent has protected atomic storage", () => {
  const f = stateFixture();
  ownReleaseRoot(f.config.deployment);
  saveSourceState(f.config, f.state);
  expect(readSourceState(f.config)).toEqual(f.state);
  if (platform.posixOwnership) expect(statSync(f.statePath).mode & 0o077).toBe(0);
  expect(readFileSync(f.statePath, "utf8")).not.toContain("private-session");
});

for (const [scope, field, value] of [
  ["state", "version", 2],
  ["state", "unexpected", true],
  ["state", "failedCommits", "short"],
  ["state", "failedCommits", ["short"]],
  ["state", "failedCommits", ["a".repeat(40), "a".repeat(40)]],
  ["job", "repository", "wrong/repo/extra"],
  ["job", "deploymentConfigHash", "short"],
  ["current", "path", "relative"],
  ["current", "sourceHash", "short"],
  ["target", "commit", "short"],
  ["target", "ahead", 0],
  ["ci", "attempt", 0],
  ["input", "remote", "https://github.com/different/repository.git"],
  ["input", "candidate", "/different-candidate"],
  ["input", "tree", "e".repeat(40)],
  ["manifest", "hash", "f".repeat(64)],
  ["deployment", "inputHash", "f".repeat(64)],
  ["deployment", "directory", "/different-journal"],
  ["deployment", "releasePath", "/different-release"],
  ["deployment", "status", "invented"],
  ["deployment", "stopRequestedAt", "not-a-date"],
] as const) {
  test(`source state rejects changed ${scope}.${field} before using recovery identity`, () => {
    const f = stateFixture();
    const buckets = {
      state: f.state,
      job: f.job,
      current: f.job.current,
      target: f.job.target,
      ci: f.job.target.ci,
      input: f.job.input,
      manifest: f.job.input.publicManifest,
      deployment: f.deployment,
    };
    Reflect.set(buckets[scope], field, value);
    expect(() => parseSourceState(f.config, f.state)).toThrow(DeploymentHeld);
  });
}

test("source recovery distinguishes completed pre-effect holds from effectful or failed work", () => {
  const f = stateFixture();
  const record = f.deployment;
  const pending = { ...f.job };
  delete pending.deployment;
  expect(sourceRecoveryPending(pending)).toBe(true);
  for (const status of ["healthy", "rolled-back"] as const)
    expect(sourceRecoveryPending({ ...f.job, deployment: { ...record, status, step: "done" } })).toBe(false);
  for (const step of ["prepare", "stop"] as const) {
    expect(sourceRecoveryPending({ ...f.job, deployment: { ...record, status: "held", step } })).toBe(false);
    // A stop receipt is the headless forward-stop effect.
    for (const receipt of ["stopRequestedAt", "nativeExitObservedAt"] as const)
      expect(
        sourceRecoveryPending({
          ...f.job,
          deployment: { ...record, status: "held", step, [receipt]: record.createdAt },
        }),
      ).toBe(true);
  }
  expect(sourceRecoveryPending({ ...f.job, deployment: { ...record, status: "failed", step: "done" } })).toBe(true);
  expect(sourceRecoveryPending({ ...f.job, deployment: { ...record, status: "held", step: "health" } })).toBe(true);
});

posixJournal("source recovery consults the identity-bound inner journal before superseding a held outer intent", () => {
  const f = stateFixture();
  f.deployment.status = "held";
  f.deployment.step = "stop";
  expect(sourceRecoveryPending(f.job)).toBe(false);
  const path = join(f.deployment.directory, "deployment.json");
  saveDeploymentJson(path, { ...f.deployment, stopRequestedAt: f.deployment.createdAt });
  expect(sourceRecoveryPending(f.job)).toBe(true);
  saveDeploymentJson(path, { ...f.deployment, id: "different-transaction" });
  expect(() => sourceRecoveryPending(f.job)).toThrow("identity differs");
});

for (const status of ["healthy", "rolled-back"] as const)
  posixJournal(`terminal ${status} inner journal needs outer reconciliation before a fresh attempt`, () => {
    const f = stateFixture();
    saveDeploymentJson(join(f.deployment.directory, "deployment.json"), { ...f.deployment, status, step: "done" });
    expect(sourceRecoveryPending(f.job)).toBe(true);
    f.deployment.status = status;
    f.deployment.step = "done";
    expect(sourceRecoveryPending(f.job)).toBe(false);
  });

const processTest = test.skipIf(!platform.supportsProcessReaders);
processTest("source apply and separate restart share a process-owned controller lock", async () => {
  const f = stateFixture();
  ownReleaseRoot(f.config.deployment);
  const unlock = acquireRestartLock({ restartLock: join(f.config.deployment.releaseRoot, "source-update.lock") });
  try {
    await expect(applySourceUpdate(f.config)).rejects.toThrow(DeploymentHeld);
    await expect(restartSourceLead(f.config)).rejects.toThrow(DeploymentHeld);
    expect(existsSync(f.statePath)).toBe(false);
    expect(existsSync(f.config.deployment.restartLock)).toBe(false);
  } finally {
    unlock();
  }
});

test.skipIf(platform.posixOwnership)("source recovery does not trust a journal without protected storage", () => {
  const f = stateFixture();
  saveDeploymentJson(f.statePath, f.state);
  expect(() => readSourceState(f.config)).toThrow("Group/world-writable installation path");
  saveDeploymentJson(join(f.deployment.directory, "deployment.json"), f.deployment);
  expect(() => sourceRecoveryPending(f.job)).toThrow("source recovery journal is unavailable");
});
