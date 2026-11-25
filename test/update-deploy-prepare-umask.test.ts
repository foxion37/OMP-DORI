import { expect, test } from "bun:test";
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { sourceManifest } from "../src/update/source.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";
import { preparationFixture } from "./update-deploy-prepare-setup.ts";
import { git } from "./update-setup.ts";

// POSIX-only: the cases run preparation under a caller umask through /bin/sh and assert 0o222/0o077 modes.
const it = test.skipIf(process.platform === "win32");

// Real clone, frozen local dependencies and bundle admission; the explicit native is a version fixture.
it.each(["0000", "0002", "0077"])(
  "managed preparation admits locked source under caller umask %s",
  async (mask) => {
    const f = preparationFixture();
    overlayFixture(f.remote, join(f.directory, "native-upstream"));
    git(f.remote, "add", "--", "native-omp.lock", "native-omp.patch");
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
    const native = join(f.directory, "native-version-fixture");
    writeFileSync(native, '#!/bin/sh\nprintf "19.0.1\\n"\n', { mode: 0o700 });
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
        "cataly-umask-fixture",
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
    expect(observed.record.toolchain.nativeVersion).toBe("19.0.1");
    expect(observed.record.toolchain.extensionSource).toBe(record.releasePath);
    expect(sourceManifest(record.releasePath).hash).toBe(full.hash);
    expect(sourceManifest(f.candidate)).toEqual(full);
    for (const file of full.files) expect(lstatSync(join(record.releasePath, file.path)).mode & 0o222).toBe(0);
    expect(lstatSync(join(record.releasePath, ".git")).mode & 0o077).toBe(0);
    expect(lstatSync(config.liveSource, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(f.home, ".cataly/config.json"), "utf8")).toBe('{"owner":"unchanged"}\n');
    expect(readFileSync(join(f.home, ".cataly/state/owner.json"), "utf8")).toBe('{"cursor":17}\n');
    // The fix must not relax admission for an independently writable lock.
    chmodSync(join(record.releasePath, "native-omp.lock"), 0o666);
    expect(() => readSourceBundle(record.releasePath)).toThrow("Group/world-writable installation path");
  },
  30_000,
);
