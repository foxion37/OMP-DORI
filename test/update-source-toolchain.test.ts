import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provisionSourceOverlay } from "../src/release/source-checkout.ts";
import { parseDeploymentConfig } from "../src/update/deployment-config.ts";
import { actorEnv } from "../src/update/deployment-process.ts";
import { assertRuntimeToolchain, prepareRuntimeToolchain } from "../src/update/deployment-toolchain.ts";
import type { DeploymentRecord, ToolchainReceipt } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

const roots: string[] = [];
// POSIX-only: the bundle fixture is admitted by permission-bit checks (0o022) and built from symlinks.
const it = test.skipIf(process.platform === "win32");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-source-toolchain-")));
  roots.push(root);
  const source = join(root, "release");
  const ulw = overlayFixture(source, join(root, "ulw-upstream"));
  const native = overlayFixture(source, join(root, "native-upstream"), true);
  const home = join(root, "home");
  const receipt = nativeCacheFixture(source, home, native.checkout);
  mkdirSync(join(source, "scripts"));
  symlinkSync(
    resolve(import.meta.dir, "../scripts/source-dependencies.ts"),
    join(source, "scripts/source-dependencies.ts"),
  );
  const config = parseDeploymentConfig(
    {
      releaseRoot: join(root, "managed"),
      liveSource: join(home, ".dori/src"),
      home,
      doriHome: join(home, ".dori"),
      doriConfig: join(home, ".dori/config.json"),
      stateDir: join(home, ".dori/state"),
      bun: process.execPath,
      herdr: process.execPath,
      pane: "w1:p1",
      sessionId: "fixture-session",
      model: "fixture/model",
      restartLock: join(home, ".dori/restart.lock"),
      launcherPath: join(home, ".dori/bin/restart"),
      healthTimeoutMs: 100,
    },
    root,
  );
  const record: DeploymentRecord = {
    version: 1,
    id: "fixture",
    inputHash: "input",
    configHash: "config",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: "c".repeat(64),
    releasePath: source,
    directory: join(root, "transaction"),
    createdAt: new Date().toISOString(),
    status: "prepared",
    step: "prepare",
  };
  return { root, source, home, ulw, receipt, config, record };
}

it("managed default preparation binds native and ULW source identities and propagates those actual consumers", async () => {
  const f = fixture();
  await provisionSourceOverlay(f.source, f.home, undefined, f.ulw.checkout);
  await prepareRuntimeToolchain(f.config, f.record);
  expect(f.config.omp).toBeUndefined();
  expect(f.record.toolchain?.nativeSource?.identity).toBe(f.receipt.identity);
  expect(f.record.toolchain?.nativeOverride).toBeUndefined();
  expect(JSON.parse(actorEnv(f.config, f.record.toolchain)["DORI_AGENT_ARGV"]!)).toEqual([
    f.receipt.omp,
    "--config",
    f.record.toolchain!.nativeConfig,
    "--no-extensions",
    "-e",
    join(f.source, "extension"),
  ]);
  expect(actorEnv(f.config, f.record.toolchain)["DORI_AGENT_CMD"]).toBeUndefined();
  expect(actorEnv(f.config, f.record.toolchain)["DORI_OMP_ULW_PATH"]).toBe(
    join(f.record.toolchain!.ompUlw!.directory, "index.ts"),
  );
  await prepareRuntimeToolchain(f.config, f.record);
  assertRuntimeToolchain(f.config, f.record.toolchain!);
  const changed = join(f.receipt.directory, "source/index.ts");
  writeFileSync(changed, "source drift\n");
  expect(() => assertRuntimeToolchain(f.config, f.record.toolchain!)).toThrow();
  expect(readFileSync(changed, "utf8")).toBe("source drift\n");
}, 30_000);

it("a same-version old-style receipt cannot admit a new locked default", async () => {
  const f = fixture();
  const versionOnly: ToolchainReceipt = {
    omp: f.receipt.omp,
    ompEntry: f.receipt.omp,
    ompEntryHash: digest(readFileSync(f.receipt.omp)),
    bun: f.config.bun,
    bunHash: digest(readFileSync(f.config.bun)),
    nativeVersion: "18.20.0",
    nativeConfig: join(f.config.releaseRoot, "native-config.json"),
    nativeConfigHash: digest("{}"),
  };
  f.record.toolchain = versionOnly;
  await expect(prepareRuntimeToolchain(f.config, f.record)).rejects.toThrow("configured target");
});
