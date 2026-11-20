import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { DoriConfig } from "../skills/dori-mode/scripts/src/config.ts";
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
  const [side, expectedFile, previousFile, runtime] = process.argv.slice(2);
  assert(side && expectedFile && previousFile && runtime, "Inspector requires side, current, previous and runtime");
  const home = realpathSync(process.env["HOME"]!);
  const context = JSON.parse(readFileSync(join(dirname(home), "namespace.json"), "utf8"));
  assert.equal(context.home, home, "Inspector requires the driver's private namespace receipt");
  assert.equal(context.side, side);
  assert.equal(dirname(side), home, "Consumer must be inside the private HOME");
  const expected = validateReleaseManifest(JSON.parse(readFileSync(expectedFile, "utf8")));
  const previous =
    previousFile === "-" ? undefined : validateReleaseManifest(JSON.parse(readFileSync(previousFile, "utf8")));
  const source = realpathSync(join(side, "src"));
  // Static imports cannot select the physical installed release: every module below belongs to its runtime path.
  const { consumerPaths } = await import(join(source, "src/release/files.ts"));
  const { loadInstalled, assertInstalledPointer, verifyRelease, releasePath } = await import(
    join(source, "src/release/state.ts")
  );
  const { prepareConsumerDiscovery } = await import(join(source, "src/release/discovery.ts"));
  const { assertNativeSource } = await import(join(source, "src/release/native.ts"));
  const { assertSourceBundle, readSourceBundle } = await import(join(source, "src/release/source-bundle.ts"));
  const { loadConfig } = await import(join(source, "skills/dori-mode/scripts/src/config.ts"));
  const { runtimesFor } = await import(join(source, "skills/dori-mode/scripts/src/run.ts"));
  const paths = consumerPaths(home, side);
  const state = loadInstalled(paths);
  assert.deepEqual(state?.current, expected);
  assert.deepEqual(state?.previous, previous);
  assertInstalledPointer(paths, state);
  assert.equal(verifyRelease(paths, expected), source);
  assert.equal(source, releasePath(paths, expected));
  if (previous) verifyRelease(paths, previous);
  assert.equal(expected.requirements.omp, "18.20.0");
  const native: NativeReceipt = assertNativeSource(source, home);
  process.env["PI_NATIVES_DIR"] = join(native.directory, "natives");
  const loader = await import(join(native.directory, "source/packages/natives/native/loader-state.js"));
  assert.equal(loader.loadNative().__piNativesBuildVersion(), "18.20.0");
  const addon = loader.nativeAddonStatus();
  assert.equal(addon.version, "18.20.0");
  assert.equal(addon.stale, false);
  assert.equal(realpathSync(addon.path), realpathSync(native.addon));
  const config: DoriConfig = await loadConfig(paths.config, home);
  assert.equal(config.runtime, runtime);
  assert.equal(config.stateDir, join(side, "state"));
  assert.equal(config.agentCommand[0], join(source, "scripts/consumer/omp"));
  for (const selected of [join(source, "extension"), join(side, "omp.yml")]) {
    assert(config.agentCommand.includes(selected), `Missing selected native argument: ${selected}`);
  }
  const overlay = join(paths.root, "consumer-discovery", basename(source), "omp.yml");
  assert(config.agentCommand.includes(overlay));
  assert(lstatSync(dirname(overlay)).isDirectory(), "Installed discovery overlay is missing");
  prepareConsumerDiscovery(paths, source);
  const skill = readFileSync(join(dirname(overlay), "skills/omp-dori-mode/SKILL.md"), "utf8");
  assert.match(skill, /^name: omp-dori-mode$/m);
  const ulw = readSourceBundle(source);
  const dependency = join(paths.dependencies, `omp-ulw-${expected.ompUlw.commit}-${ulw.identity}`);
  assert.equal(config.ompUlwPath, join(dependency, "index.ts"));
  assertSourceBundle(dependency, ulw, home);
  const namespace = `omp-dori-${digest(side).slice(0, 12)}`;
  assert.equal(process.env["HC_SESSION"], namespace);
  assert.equal(process.env["DORI_HERDR_SESSION"], namespace);
  assert.equal(process.env["DORI_RUNTIME"], undefined);
  const runtimes = runtimesFor(config, process.env);
  assert.deepEqual(runtimes.choice, { kind: runtime, source: "config" });
  assert.equal(runtimes.default.kind, runtime);
  assert.deepEqual(await runtimes.default.list(), [], "Fresh private runtime unexpectedly contains sessions");
  console.log(
    JSON.stringify(
      {
        source,
        current: state.current,
        previous: state.previous,
        native,
        addon,
        runtime: runtimes.choice,
        namespace,
        agentCommand: config.agentCommand,
        ompUlwPath: config.ompUlwPath,
      },
      null,
      2,
    ),
  );
}
