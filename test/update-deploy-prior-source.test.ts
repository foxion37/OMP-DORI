import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionSourceOverlay } from "../src/release/source-checkout.ts";
import type { DeploymentCli } from "../src/update/deployment-cli.ts";
import { ownReleaseRoot } from "../src/update/deployment-files.ts";
import { launchRuntime } from "../src/update/deployment-launch.ts";
import { admitRuntimeToolchains } from "../src/update/deployment-prior.ts";
import { managedOmpCommand, processIdentity } from "../src/update/deployment-process.ts";
import { assertRuntimeToolchain } from "../src/update/deployment-toolchain.ts";
import type { DeploymentRecord, RuntimeIdentity } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { overlayFixture } from "./source-bundle-setup.ts";
import { deploymentConfig } from "./update-deploy-setup.ts";

const roots: string[] = [];
// POSIX-only: the fixture is a shebang native binary with symlinked overlays and POSIX process identities.
const it = test.skipIf(process.platform === "win32");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** First directory-to-managed conversion: no active receipt, no legacy override, old actor runs the new native image. */
async function conversion(sameOverlay: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-prior-source-")));
  roots.push(root);
  const omp = join(root, "private-omp/omp");
  mkdirSync(join(root, "private-omp"), { mode: 0o700 });
  writeFileSync(omp, '#!/bin/sh\nprintf "18.20.0\\n"\n', { mode: 0o700 });
  const config = { ...deploymentConfig(root), omp, bun: process.execPath };
  ownReleaseRoot(config);
  const release = join(config.releaseRoot, "releases/new");
  const ulw = overlayFixture(release, join(root, "ulw-upstream"));
  overlayFixture(release, join(root, "native-upstream"), true);
  mkdirSync(join(release, "extension"));
  writeFileSync(join(release, "extension/index.ts"), "export const generation = 'new';\n");
  await provisionSourceOverlay(release, config.home, undefined, ulw.checkout);
  mkdirSync(join(config.liveSource, "extension"), { recursive: true });
  writeFileSync(join(config.liveSource, "extension/index.ts"), "export const generation = 'directory';\n");
  if (sameOverlay)
    for (const name of ["omp-ulw.overlay.lock", "omp-ulw.patch", "omp-ulw.lock"])
      copyFileSync(join(release, name), join(config.liveSource, name));
  else overlayFixture(config.liveSource, join(root, "ulw-older"), false, "older-overlay");
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
    role: "dori",
    pane: config.pane,
    sessionId: config.sessionId,
    sessionFile: join(root, "session.jsonl"),
    startedAt: record.createdAt,
    cwd: root,
    executableHash: digest(readFileSync(omp)),
  };
  return { config, record, runtime, oldSource };
}

it("a first conversion binds its rollback toolchain to the prior source before any stop", async () => {
  const f = await conversion(true);
  f.record.oldRuntime = await admitRuntimeToolchains(f.config, f.record, f.runtime, undefined, true);
  const old = f.record.oldToolchain!;
  expect(old.ompUlw?.source).toBe(f.oldSource);
  expect(f.record.toolchain?.ompUlw?.source).toBe(f.record.releasePath);
  assertRuntimeToolchain(f.config, old);
  expect(managedOmpCommand(old, f.oldSource)).toEqual([
    old.omp,
    "--config",
    old.nativeConfig,
    "--no-extensions",
    "-e",
    join(f.oldSource, "extension"),
  ]);
  // The rollback launch builds its command before observing the pane; reaching the pane proves it is launchable.
  const cli = {
    foreground: async () => {
      throw new Error("rollback reached the pane shell check");
    },
  } as unknown as DeploymentCli;
  await expect(launchRuntime(f.config, cli, f.record, false, true)).rejects.toThrow(
    "rollback reached the pane shell check",
  );
});

it("a prior source pinning a different extension overlay is held before any stop", async () => {
  const f = await conversion(false);
  await expect(admitRuntimeToolchains(f.config, f.record, f.runtime, undefined, true)).rejects.toThrow(
    "prior source cannot be relaunched with the prepared extension overlay",
  );
});
