import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../skills/dori-mode/scripts/src/config.ts";
import { extractArchive, readArchive } from "../src/release/archive.ts";
import { saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { resolveConsumerOmpUlwPath } from "../src/release/runtime.ts";
import { releasePath } from "../src/release/state.ts";
import { sourceManifest } from "../src/update/source.ts";
import { archive, fixture, withArchive } from "./release-consumer-setup.ts";
import { git } from "./update-setup.ts";

test("managed dependency resolution follows each loaded release across update and rollback without config writes", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("first\n").bundle, undefined);
  const sourceOne = releasePath(f.paths, one.current);
  const config = readFileSync(f.paths.config);
  const configured = (await loadConfig(f.paths.config, f.paths.home)).ompUlwPath;
  const effective = (sourceRoot: string, path = configured) =>
    resolveConsumerOmpUlwPath(path, { home: f.paths.home, sourceRoot });
  expect(configured).toBe(join(f.ownedDependency, "index.ts"));
  expect(git(dirname(effective(sourceOne)), "rev-parse", "HEAD")).toBe(f.pin);

  const checkout = join(f.root, "next-dependency");
  mkdirSync(checkout, { mode: 0o700 });
  git(f.root, "clone", "--quiet", "--no-hardlinks", f.ownedDependency, checkout);
  chmodSync(join(checkout, "index.ts"), 0o600);
  git(
    checkout,
    "-c",
    "user.name=Consumer fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Second isolated public dependency pin",
  );
  const nextPin = git(checkout, "rev-parse", "HEAD");
  expect(nextPin).not.toBe(f.pin);
  const nextDependency = join(f.paths.dependencies, `omp-ulw-${nextPin}`);
  renameSync(checkout, nextDependency);
  saveJson(`${nextDependency}.json`, { version: 1, repository: one.current.ompUlw.repository, commit: nextPin });

  const next = f.release("second\n");
  const source = join(f.root, "next-source");
  extractArchive(next.bundle.files, next.bundle.manifest, source);
  writeFileSync(join(source, "omp-ulw.lock"), `${nextPin}\n`);
  const manifestSource = sourceManifest(source);
  const bytes = archive(
    manifestSource.files.map((file) => ({
      name: `${next.bundle.manifest.archive.root}/${file.path}`,
      bytes: readFileSync(join(source, file.path)),
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = withArchive(
    validateReleaseManifest({
      ...next.bundle.manifest,
      source: manifestSource,
      ompUlw: { ...next.bundle.manifest.ompUlw, commit: nextPin },
    }),
    bytes,
  );
  const two = await installBundle(f.paths, { manifest, files: readArchive(bytes, manifest) }, one);
  const sourceTwo = releasePath(f.paths, two.current);
  expect(git(dirname(effective(sourceTwo)), "rev-parse", "HEAD")).toBe(nextPin);
  expect(effective(sourceTwo, dirname(configured))).toBe(nextDependency);
  expect(effective(sourceOne)).toBe(configured);
  expect(readFileSync(f.paths.config)).toEqual(config);

  const rolled = await rollbackRelease(f.paths, two);
  expect(effective(releasePath(f.paths, rolled.current))).toBe(configured);
  expect(effective(sourceOne, dirname(configured))).toBe(f.ownedDependency);
  expect(effective(sourceTwo)).toBe(join(nextDependency, "index.ts"));
  expect(readFileSync(f.paths.config)).toEqual(config);
});

test("explicit dependency paths and ordinary source checkouts remain user choices", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("first\n").bundle, undefined);
  const sourceRoot = releasePath(f.paths, one.current);
  const managed = join(f.ownedDependency, "index.ts");
  for (const configured of [
    join(f.paths.home, "extensions/ulw/index.ts"),
    join(f.paths.home, ".dori/omp-ulw/index.ts"),
    join(f.root, "external/consumer-dependencies", `omp-ulw-${f.pin}`, "index.ts"),
    join(f.ownedDependency, "custom.ts"),
    join(f.paths.dependencies, `omp-ulw-${"A".repeat(40)}`, "index.ts"),
  ]) {
    expect(resolveConsumerOmpUlwPath(configured, { home: f.paths.home, sourceRoot })).toBe(configured);
  }
  // This loadConfig comes from the ordinary repository checkout, even with a consumer-shaped config path.
  expect((await loadConfig(f.paths.config, f.paths.home)).ompUlwPath).toBe(managed);

  const checkout = join(f.root, "source-checkout");
  mkdirSync(checkout, { mode: 0o700 });
  writeFileSync(join(checkout, "omp-ulw.lock"), "not a consumer lock\n", { mode: 0o600 });
  const alias = join(f.paths.releases, `${"c".repeat(40)}-${"d".repeat(16)}`);
  symlinkSync(checkout, alias);
  const nested = join(f.paths.releases, "nested", `${"e".repeat(40)}-${"f".repeat(16)}`);
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  for (const root of [checkout, alias, nested, f.paths.releases]) {
    expect(resolveConsumerOmpUlwPath(managed, { home: f.paths.home, sourceRoot: root })).toBe(managed);
  }

  const customConfig = '{"ompUlwPath":"~/extensions/ulw/index.ts"}\n';
  writeFileSync(f.paths.config, customConfig);
  const loaded = await loadConfig(f.paths.config, f.paths.home);
  expect(loaded.ompUlwPath).toBe(join(f.paths.home, "extensions/ulw/index.ts"));
  expect(resolveConsumerOmpUlwPath(loaded.ompUlwPath, { home: f.paths.home, sourceRoot })).toBe(loaded.ompUlwPath);
  expect(readFileSync(f.paths.config, "utf8")).toBe(customConfig);
});

test("managed dependency resolution holds on invalid or linked lock metadata and an absent pinned cache", () => {
  const f = fixture();
  const sourceRoot = join(f.paths.releases, `${"a".repeat(40)}-${"b".repeat(16)}`);
  mkdirSync(sourceRoot, { mode: 0o700 });
  const lock = join(sourceRoot, "omp-ulw.lock");
  const configured = join(f.ownedDependency, "index.ts");
  const resolve = () => resolveConsumerOmpUlwPath(configured, { home: f.paths.home, sourceRoot });
  expect(resolve).toThrow("Missing consumer release lock");
  for (const value of ["../outside", "g".repeat(40), `${f.pin}\nextra`]) {
    writeFileSync(lock, `${value}\n`, { mode: 0o600 });
    expect(resolve).toThrow("Invalid consumer release lock");
  }
  unlinkSync(lock);
  const externalLock = join(f.root, "external.lock");
  writeFileSync(externalLock, `${f.pin}\n`, { mode: 0o600 });
  symlinkSync(externalLock, lock);
  expect(resolve).toThrow("Expected a real file");
  unlinkSync(lock);
  writeFileSync(lock, `${"0".repeat(40)}\n`, { mode: 0o600 });
  expect(resolve).toThrow("Missing consumer dependency entry");
});
