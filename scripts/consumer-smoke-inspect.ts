import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { CatalyConfig } from "../skills/cataly-mode/scripts/src/config.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import type { NativeReceipt } from "../src/release/native.ts";
import { digest } from "../src/update/source.ts";

/** Record bytes, links, ownership and modes without following links or changing the inspected tree. */
export function snapshot(root: string): string {
  const rows: unknown[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const name = relative(root, path);
    if (stat.isSymbolicLink()) rows.push([name, stat.mode, stat.uid, "link", readlinkSync(path)]);
    else if (stat.isFile()) rows.push([name, stat.mode, stat.uid, "file", digest(readFileSync(path))]);
    else {
      assert(stat.isDirectory(), `Unexpected special file: ${path}`);
      rows.push([name, stat.mode, stat.uid, "directory"]);
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    }
  };
  visit(root);
  return JSON.stringify(rows);
}

if (import.meta.main) {
  const [side, expectedFile] = process.argv.slice(2);
  assert(side && expectedFile, "Inspector requires side and current release manifest");
  const home = realpathSync(process.env["HOME"]!);
  const context = JSON.parse(readFileSync(join(dirname(home), "namespace.json"), "utf8"));
  assert.equal(context.home, home, "Inspector requires the driver's private namespace receipt");
  assert.equal(context.side, side);
  assert.equal(dirname(side), home, "Consumer must be inside the private HOME");
  // This program imports modules directly; installed CLI and OMP launchers are exercised without these bindings.
  process.env["CATALY_HOME"] = side;
  process.env["CATALY_CONFIG"] = join(side, "config.json");
  const expected = validateReleaseManifest(JSON.parse(readFileSync(expectedFile, "utf8")));
  const source = realpathSync(join(side, "src"));
  // Static imports cannot select the physical installed release: every module below belongs to its runtime path.
  const { consumerPaths } = await import(join(source, "src/release/files.ts"));
  const { loadInstalled, assertInstalledPointer, verifyRelease, releasePath } = await import(
    join(source, "src/release/state.ts")
  );
  const { prepareConsumerDiscovery } = await import(join(source, "src/release/discovery.ts"));
  const { assertNativeSource } = await import(join(source, "src/release/native.ts"));
  const { readSourceBundle } = await import(join(source, "src/release/source-bundle.ts"));
  const { loadConfig } = await import(join(source, "skills/cataly-mode/scripts/src/config.ts"));
  const { runtimesFor } = await import(join(source, "skills/cataly-mode/scripts/src/run.ts"));
  const paths = consumerPaths(home, side);
  const state = loadInstalled(paths);
  assert.deepEqual(state?.current, expected);
  assertInstalledPointer(paths, state);
  assert.equal(verifyRelease(paths, expected), source);
  assert.equal(source, releasePath(paths, expected));
  if (state?.previous) verifyRelease(paths, state.previous);
  assert.equal(expected.requirements.omp, readSourceBundle(source).lock.nativeVersion);
  const native: NativeReceipt = assertNativeSource(source, home);
  process.env["PI_NATIVES_DIR"] = join(native.directory, "natives");
  const loader = await import(join(native.directory, "source/packages/natives/native/loader-state.js"));
  assert.equal(loader.loadNative().__piNativesBuildVersion(), expected.requirements.omp);
  const addon = loader.nativeAddonStatus();
  assert.equal(addon.version, expected.requirements.omp);
  assert.equal(addon.stale, false);
  assert.equal(realpathSync(addon.path), realpathSync(native.addon));
  const config: CatalyConfig = await loadConfig(paths.config, home);
  assert.equal(config.stateDir, join(side, "state"));
  assert.equal(config.agentCommand[0], join(source, "scripts/consumer/omp"));
  for (const selected of [join(source, "extension"), join(side, "omp.yml")]) {
    assert(config.agentCommand.includes(selected), `Missing selected native argument: ${selected}`);
  }
  const overlay = join(paths.root, "consumer-discovery", basename(source), "omp.yml");
  assert(config.agentCommand.includes(overlay));
  assert(lstatSync(dirname(overlay)).isDirectory(), "Installed discovery overlay is missing");
  prepareConsumerDiscovery(paths, source);
  const skill = readFileSync(join(dirname(overlay), "skills/omp-cataly-mode/SKILL.md"), "utf8");
  assert.match(skill, /^name: omp-cataly-mode$/m);
  assert.equal(process.env["CATALY_RUNTIME"], undefined);
  const runtimes = runtimesFor(config, process.env);
  assert.deepEqual(runtimes.choice, { kind: "headless", source: "default" });
  assert.equal(runtimes.default.kind, "headless");
  assert.deepEqual(await runtimes.default.list(), [], "Fresh private runtime unexpectedly contains sessions");
  const { HeadlessRuntime } = await import(join(source, "src/runtime/headless.ts"));
  const { assertNoLiveCataly } = await import(join(source, "src/release/live.ts"));
  const local = new HeadlessRuntime(join(context.out, "explicit-native-state"));
  const ref = await local.create({
    name: "release reservation witness",
    role: "duty-loop",
    container: "tab",
    cwd: join(context.out, "workspace"),
    env: {},
  });
  try {
    assert.throws(() => assertNoLiveCataly(paths), /Native session .* holds release activation/);
    const live = await local.startLoop(ref, { CATALY_STATE_DIR: local.stateDir, CATALY_RUNTIME: "headless" });
    assert.equal(live.status, "working");
    assert.equal(live.harnessRole, "duty-loop");
    // Once the duty process starts, its own controller lock can take precedence over its reservation.
    assert.throws(
      () => assertNoLiveCataly(paths),
      /Native session .* holds release activation|Live Cataly PID \d+ holds duty\/lock/,
    );
  } finally {
    await local.stopHarnessRole(ref, "duty-loop");
  }
  assert.doesNotThrow(() => assertNoLiveCataly(paths));
  console.log(
    JSON.stringify(
      {
        source,
        current: state.current,
        previous: state.previous,
        native,
        addon,
        runtime: runtimes.choice,
        agentCommand: config.agentCommand,
      },
      null,
      2,
    ),
  );
}
