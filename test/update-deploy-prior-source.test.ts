import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownReleaseRoot } from "../src/update/deployment-files.ts";
import { admitRuntimeToolchains } from "../src/update/deployment-prior.ts";
import { managedOmpCommand, processIdentity } from "../src/update/deployment-process.ts";
import { assertRuntimeToolchain } from "../src/update/deployment-toolchain.ts";
import type { DeploymentRecord, RuntimeIdentity } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { overlayFixture } from "./source-bundle-setup.ts";
import { deploymentConfig } from "./update-deploy-setup.ts";

const roots: string[] = [];
// POSIX-only: the fixture is a shebang native binary with POSIX process identities.
const it = test.skipIf(process.platform === "win32");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** First directory-to-managed conversion: no active receipt, no native override, old actor runs the new native image. */
async function conversion() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-prior-source-")));
  roots.push(root);
  const omp = join(root, "private-omp/omp");
  mkdirSync(join(root, "private-omp"), { mode: 0o700 });
  writeFileSync(omp, '#!/bin/sh\nprintf "19.0.1\\n"\n', { mode: 0o700 });
  const config = { ...deploymentConfig(root), omp, bun: process.execPath };
  ownReleaseRoot(config);
  const release = join(config.releaseRoot, "releases/new");
  overlayFixture(release, join(root, "native-upstream"));
  mkdirSync(join(release, "extension"));
  writeFileSync(join(release, "extension/index.ts"), "export const generation = 'new';\n");
  mkdirSync(join(config.liveSource, "extension"), { recursive: true });
  writeFileSync(join(config.liveSource, "extension/index.ts"), "export const generation = 'directory';\n");
  const oldSource = realpathSync(config.liveSource);
  const id = "first-conversion";
  const record: DeploymentRecord = {
    version: 1,
    id,
    inputHash: "input",
    configHash: "config",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: sourceManifest(release).hash,
    releasePath: release,
    directory: join(config.releaseRoot, "transactions", id),
    createdAt: new Date().toISOString(),
    status: "starting",
    step: "start",
    oldSource,
    oldSourceHash: sourceManifest(oldSource).hash,
  };
  mkdirSync(record.directory, { recursive: true, mode: 0o700 });
  const runtime: RuntimeIdentity = {
    ...processIdentity(process.pid)!,
    role: "cataly",
    ref: "00000000-0000-4000-8000-000000000001",
    sessionId: "prior-session",
    sessionFile: join(root, "session.jsonl"),
    startedAt: record.createdAt,
    cwd: root,
    executableHash: digest(readFileSync(omp)),
  };
  return { config, record, runtime, oldSource };
}

it("a first conversion binds its rollback toolchain to the prior source before any stop", async () => {
  const f = await conversion();
  f.record.oldRuntime = await admitRuntimeToolchains(f.config, f.record, f.runtime, undefined, true);
  const old = f.record.oldToolchain!;
  expect(old.extensionSource).toBe(f.oldSource);
  expect(f.record.toolchain?.extensionSource).toBe(f.record.releasePath);
  assertRuntimeToolchain(f.config, old);
  expect(managedOmpCommand(old, f.oldSource)).toEqual([
    old.omp,
    "--config",
    old.nativeConfig,
    "--no-extensions",
    "-e",
    join(f.oldSource, "extension"),
  ]);
});
