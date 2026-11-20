import { expect, test } from "bun:test";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readArchive } from "../src/release/archive.ts";
import { saveJson } from "../src/release/files.ts";
import { installBundle } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { digest } from "../src/update/source.ts";
import { archive, fixture } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix("reinstall refreshes the owned OMP launcher after its executable moves", async () => {
  const f = fixture(true);
  const first = join(f.root, "first-toolchain"),
    second = join(f.root, "second-toolchain");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "omp"), "#!/bin/sh\nprintf 'relocated-omp\\n'\n", { mode: 0o755 });
  const previous = process.env["PATH"];
  process.env["PATH"] = `${first}:${previous ?? ""}`;
  try {
    const bundle = f.release("first\n").bundle;
    const installed = await installBundle(f.paths, bundle, undefined);
    const config = readFileSync(f.paths.config);
    const receipt = join(f.paths.root, "consumer-references.json");
    const before = JSON.parse(readFileSync(receipt, "utf8"));
    renameSync(join(first, "omp"), join(second, "omp"));
    process.env["PATH"] = `${second}:${previous ?? ""}`;
    await installBundle(f.paths, bundle, installed);
    const after = JSON.parse(readFileSync(receipt, "utf8"));
    const references = Object.fromEntries(
      Object.keys(after).map((path) => [
        path,
        {
          bytes: readFileSync(join(f.paths.dori, path), "utf8"),
          executable: path.startsWith("bin/"),
        },
      ]),
    );
    const pending = join(f.paths.root, "consumer-references-pending.json");
    saveJson(pending, { before, references });
    saveJson(receipt, before);
    await installBundle(f.paths, bundle, installed);
    expect(existsSync(pending)).toBe(false);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(after);
    const result = Bun.spawnSync([join(f.paths.dori, "bin/omp"), "--version"], {
      env: { HOME: f.paths.home, PATH: `${second}:${previous ?? ""}` },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("relocated-omp\n");
    expect(readFileSync(f.paths.config)).toEqual(config);
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
});

posix("reinstall from a relocated real Bun repairs its owned CLI launcher", () => {
  const f = fixture(true);
  const release = f.release("first\n");
  const witness = 'console.log(JSON.stringify({ executable: process.execPath, home: process.env["DORI_HOME"] }));\n';
  const files = [
    ...release.bundle.files,
    {
      path: "skills/dori-mode/scripts/src/cli.ts",
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
      hash: digest(JSON.stringify({ files: entries, ulwPresent: false })),
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
  const native = join(f.root, "native");
  mkdirSync(native);
  writeFileSync(join(native, "omp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const worker = join(f.root, "reinstall.ts");
  writeFileSync(
    worker,
    `
import { acquireBundle } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/bundle.ts"))};
import { consumerPaths } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/files.ts"))};
import { installBundle } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/install.ts"))};
import { loadInstalled } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/state.ts"))};
const paths = consumerPaths(${JSON.stringify(f.paths.home)}, ${JSON.stringify(f.paths.dori)});
await installBundle(paths, await acquireBundle({ from: ${JSON.stringify(release.dist)} }), loadInstalled(paths));
`,
  );
  const env = { HOME: f.paths.home, PATH: `${native}:${process.env["PATH"] ?? ""}` };
  const original = Bun.spawnSync([first, worker], { env });
  expect(original.exitCode, original.stderr.toString()).toBe(0);
  const config = readFileSync(f.paths.config);
  const receipt = join(f.paths.root, "consumer-references.json");
  const before = JSON.parse(readFileSync(receipt, "utf8"));
  const oldCli = readFileSync(join(f.paths.dori, "bin/dori"));
  renameSync(first, second);
  const reinstalled = Bun.spawnSync([second, worker], { env });
  expect(reinstalled.exitCode, reinstalled.stderr.toString()).toBe(0);
  const after = JSON.parse(readFileSync(receipt, "utf8"));
  const references = Object.fromEntries(
    Object.keys(after).map((path) => [
      path,
      {
        bytes: readFileSync(join(f.paths.dori, path), "utf8"),
        executable: path.startsWith("bin/"),
      },
    ]),
  );
  saveJson(join(f.paths.root, "consumer-references-pending.json"), { before, references });
  saveJson(receipt, before);
  writeFileSync(join(f.paths.dori, "bin/dori"), oldCli);
  const recovered = Bun.spawnSync([second, worker], { env });
  expect(recovered.exitCode, recovered.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(after);
  const launched = Bun.spawnSync([join(f.paths.dori, "bin/dori")], { env });
  expect(launched.exitCode, launched.stderr.toString()).toBe(0);
  expect(JSON.parse(launched.stdout.toString())).toEqual({ executable: second, home: f.paths.dori });
  expect(readFileSync(f.paths.config)).toEqual(config);
});
