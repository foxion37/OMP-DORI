import { expect, test } from "bun:test";
import { constants, copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readArchive } from "../src/release/archive.ts";
import { saveJson } from "../src/release/files.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { digest } from "../src/update/source.ts";
import { archive, fixture } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix("reinstall from a relocated real Bun repairs its owned CLI launcher", () => {
  const f = fixture(true);
  const release = f.release("first\n");
  const witness = 'console.log(JSON.stringify({ executable: process.execPath, home: process.env["CATALY_HOME"] }));\n';
  const files = [
    ...release.bundle.files,
    {
      path: "skills/cataly-mode/scripts/src/cli.ts",
      bytes: Buffer.from(witness),
      executable: false,
    },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries = files.map((file) => ({ path: file.path, sha256: digest(file.bytes), executable: file.executable }));
  const bytes = archive(
    files.map((file) => ({
      name: `${release.bundle.manifest.archive.root}/${file.path}`,
      bytes: file.bytes,
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = validateReleaseManifest({
    ...release.bundle.manifest,
    archive: { ...release.bundle.manifest.archive, sha256: digest(bytes), bytes: bytes.length },
    source: {
      ...release.bundle.manifest.source,
      files: entries,
      hash: digest(JSON.stringify({ files: entries })),
    },
  });
  readArchive(bytes, manifest);
  const metadata = JSON.stringify(manifest);
  writeFileSync(join(release.dist, manifest.archive.name), bytes);
  writeFileSync(join(release.dist, "release-manifest.json"), metadata);
  writeFileSync(
    join(release.dist, "SHA256SUMS"),
    `${digest(metadata)}  release-manifest.json\n${digest(bytes)}  ${manifest.archive.name}\n`,
  );
  const first = join(f.root, "bun-first"),
    second = join(f.root, "bun-second");
  copyFileSync(process.execPath, first, constants.COPYFILE_FICLONE);
  const worker = join(f.root, "reinstall.ts");
  writeFileSync(
    worker,
    `
import { acquireBundle } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/bundle.ts"))};
import { consumerPaths } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/files.ts"))};
import { installBundle } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/install.ts"))};
import { loadInstalled } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/state.ts"))};
const paths = consumerPaths(${JSON.stringify(f.paths.home)}, ${JSON.stringify(f.paths.cataly)});
await installBundle(paths, await acquireBundle({ from: ${JSON.stringify(release.dist)} }), loadInstalled(paths));
`,
  );
  const env = { HOME: f.paths.home, PATH: process.env["PATH"] ?? "" };
  // The bound native cache records the exact Bun that provisioned it.
  f.rebindNative(first);
  const original = Bun.spawnSync([first, worker], { env });
  expect(original.exitCode, original.stderr.toString()).toBe(0);
  const config = readFileSync(f.paths.config);
  const receipt = join(f.paths.root, "consumer-references.json");
  const before = JSON.parse(readFileSync(receipt, "utf8"));
  const oldCli = readFileSync(join(f.paths.cataly, "bin/cataly"));
  renameSync(first, second);
  f.rebindNative(second);
  const reinstalled = Bun.spawnSync([second, worker], { env });
  expect(reinstalled.exitCode, reinstalled.stderr.toString()).toBe(0);
  const after = JSON.parse(readFileSync(receipt, "utf8"));
  const references = Object.fromEntries(
    Object.keys(after).map((path) => [
      path,
      {
        bytes: readFileSync(join(f.paths.cataly, path), "utf8"),
        executable: path.startsWith("bin/"),
      },
    ]),
  );
  saveJson(join(f.paths.root, "consumer-references-pending.json"), { before, references });
  saveJson(receipt, before);
  writeFileSync(join(f.paths.cataly, "bin/cataly"), oldCli);
  const recovered = Bun.spawnSync([second, worker], { env });
  expect(recovered.exitCode, recovered.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(after);
  const launched = Bun.spawnSync([join(f.paths.cataly, "bin/cataly")], { env });
  expect(launched.exitCode, launched.stderr.toString()).toBe(0);
  expect(JSON.parse(launched.stdout.toString())).toEqual({ executable: second, home: f.paths.cataly });
  expect(readFileSync(f.paths.config)).toEqual(config);
});
