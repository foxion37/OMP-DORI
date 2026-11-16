import { expect, test } from "bun:test";
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { provisionSourceOverlay } from "../src/release/source-checkout.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { sourceManifest } from "../src/update/source.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";
import { preparationFixture } from "./update-deploy-prepare-setup.ts";
import { git } from "./update-setup.ts";

// Real clone, frozen local dependencies and bundle admission; the explicit native is a version fixture.
test.each(["0000", "0002", "0077"])("managed preparation admits locked source under caller umask %s", async (mask) => {
  const f = preparationFixture();
  const ulw = overlayFixture(f.remote, join(f.directory, "ulw-upstream"));
  overlayFixture(f.remote, join(f.directory, "native-upstream"), true);
  git(
    f.remote,
    "add",
    "--",
    "native-omp.lock",
    "native-omp.patch",
    "omp-ulw.lock",
    "omp-ulw.overlay.lock",
    "omp-ulw.patch",
  );
  git(f.remote, "commit", "-m", "Admit locked runtime fixture");
  fixtureGit(f.candidate, "fetch", "origin");
  fixtureGit(f.candidate, "checkout", "--detach", git(f.remote, "rev-parse", "HEAD"));
  const full = sourceManifest(f.candidate);
  const input = {
    ...f.input,
    commit: git(f.remote, "rev-parse", "HEAD"),
    tree: git(f.remote, "rev-parse", "HEAD^{tree}"),
    publicManifest: sourceManifest(f.remote),
    sourceHash: full.hash,
  };
  await provisionSourceOverlay(f.candidate, f.home, undefined, ulw.checkout);
  const native = join(f.directory, "native-version-fixture");
  writeFileSync(native, '#!/bin/sh\nprintf "18.20.0\\n"\n', { mode: 0o700 });
  const config = { ...f.config, omp: native };
  const record = { ...f.record, commit: input.commit, tree: input.tree, sourceHash: full.hash };
  const payload = join(f.directory, "prepare-input.json");
  writeFileSync(payload, JSON.stringify({ config, input, record }), { mode: 0o600 });
  const driver = `
import { readFileSync } from "node:fs";
import { prepareRelease } from ${JSON.stringify(resolve(import.meta.dir, "../src/update/deployment-prepare.ts"))};
const { config, input, record } = JSON.parse(readFileSync(process.argv[1], "utf8"));
const before = process.umask();
await prepareRelease(config, input, record);
record.preparedAt = new Date().toISOString();
await prepareRelease(config, input, record);
console.log(JSON.stringify({ before, after: process.umask(), record }));
`;
  const result = Bun.spawnSync(
    [
      "/bin/sh",
      "-c",
      'umask "$1"; shift; exec "$@"',
      "dori-umask-fixture",
      mask,
      process.execPath,
      "-e",
      driver,
      payload,
    ],
    { cwd: f.directory, env: { HOME: f.home, PATH: process.env["PATH"] }, stdout: "pipe", stderr: "pipe" },
  );
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
  const observed = JSON.parse(result.stdout.toString());
  expect(observed.before).toBe(Number.parseInt(mask, 8));
  expect(observed.after).toBe(observed.before);
  expect(observed.record.toolchain.nativeOverride).toBe(true);
  expect(observed.record.toolchain.nativeVersion).toBe("18.20.0");
  expect(observed.record.toolchain.ompUlw.identity).toBe(readSourceBundle(f.candidate).identity);
  expect(sourceManifest(record.releasePath).hash).toBe(full.hash);
  expect(sourceManifest(f.candidate)).toEqual(full);
  for (const file of full.files) expect(lstatSync(join(record.releasePath, file.path)).mode & 0o222).toBe(0);
  expect(lstatSync(join(record.releasePath, ".git")).mode & 0o077).toBe(0);
  expect(lstatSync(config.liveSource, { throwIfNoEntry: false })).toBeUndefined();
  expect(readFileSync(join(f.home, ".dori/config.json"), "utf8")).toBe('{"owner":"unchanged"}\n');
  expect(readFileSync(join(f.home, ".dori/state/owner.json"), "utf8")).toBe('{"cursor":17}\n');
  // The fix must not relax admission for an independently writable lock.
  chmodSync(join(record.releasePath, "native-omp.lock"), 0o666);
  expect(() => readSourceBundle(record.releasePath, true)).toThrow("Group/world-writable installation path");
});
