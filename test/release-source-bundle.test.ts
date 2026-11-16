import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { extractArchive, readArchive } from "../src/release/archive.ts";
import { saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import {
  resolveConsumerOmpCommand,
  resolveConsumerOmpUlwPath,
  resolveProcessOmpUlwPath,
} from "../src/release/runtime.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { releasePath } from "../src/release/state.ts";
import { sourceManifest } from "../src/update/source.ts";
import { archive, type ConsumerFixture, fixture, withArchive } from "./release-consumer-setup.ts";
import { fixtureGit, nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

function bundledRelease(f: ConsumerFixture, selected: string, nativeSource?: string) {
  const original = f.release(selected);
  const source = join(f.root, `bundled-${selected}`);
  extractArchive(original.bundle.files, original.bundle.manifest, source);
  const ulw = overlayFixture(source, join(f.root, `ulw-${selected}`), false, selected);
  if (nativeSource) {
    mkdirSync(join(source, "native-addon"), { mode: 0o700 });
    for (const path of ["native-omp.lock", "native-omp.patch", "native-addon/package.json", "native-addon/bun.lock"])
      copyFileSync(join(nativeSource, path), join(source, path));
  } else {
    const native = overlayFixture(source, join(f.root, `native-${selected}`), true);
    nativeCacheFixture(source, f.paths.home, native.checkout);
  }
  mkdirSync(join(source, "scripts/consumer"), { recursive: true, mode: 0o700 });
  // Real helper bytes are carried; addon loading remains a separate real isolated installation gate.
  copyFileSync(
    resolve(import.meta.dir, "../scripts/source-dependencies.ts"),
    join(source, "scripts/source-dependencies.ts"),
  );
  copyFileSync(resolve(import.meta.dir, "../scripts/consumer/omp"), join(source, "scripts/consumer/omp"));
  chmodSync(join(source, "scripts/consumer/omp"), 0o755);
  const publicSource = sourceManifest(source);
  const bytes = archive(
    publicSource.files.map((file) => ({
      name: `${original.bundle.manifest.archive.root}/${file.path}`,
      bytes: readFileSync(join(source, file.path)),
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = withArchive(
    validateReleaseManifest({
      ...original.bundle.manifest,
      source: publicSource,
      requirements: { ...original.bundle.manifest.requirements, omp: "18.20.0" },
      ompUlw: { repository: ulw.lock.repository, commit: ulw.commit },
    }),
    bytes,
  );
  const bundle = readSourceBundle(source);
  const dependency = join(f.paths.dependencies, `omp-ulw-${ulw.commit}-${bundle.identity}`);
  renameSync(ulw.checkout, dependency);
  saveJson(`${dependency}.json`, {
    version: 1,
    repository: ulw.lock.repository,
    commit: ulw.commit,
    identity: bundle.identity,
  });
  return { source, dependency, bundle: { manifest, files: readArchive(bytes, manifest) } };
}

test("consumer install, update and reuse select each loaded release's bound overlay without rewriting config", async () => {
  const f = fixture();
  const first = bundledRelease(f, "first");
  const one = await installBundle(f.paths, first.bundle, undefined);
  const config = readFileSync(f.paths.config);
  const configured = JSON.parse(config.toString());
  const sourceOne = releasePath(f.paths, one.current);
  const omp = resolveConsumerOmpCommand(["omp", "{prompt}"], { home: f.paths.home, sourceRoot: sourceOne });
  expect(omp[0]).toBe(readlinkSync(join(f.paths.dori, "bin/omp")));
  expect(omp).toEqual([
    join(sourceOne, "scripts/consumer/omp"),
    "--no-extensions",
    "-e",
    join(sourceOne, "extension"),
    "{prompt}",
  ]);
  expect(configured.agentCommand[0]).toBe(join(f.paths.dori, "bin/omp"));
  const second = bundledRelease(f, "second", first.source);
  const two = await installBundle(f.paths, second.bundle, one);
  const sourceTwo = releasePath(f.paths, two.current);
  const effective = (sourceRoot: string) =>
    resolveConsumerOmpUlwPath(configured.ompUlwPath, { home: f.paths.home, sourceRoot });
  expect(effective(sourceOne)).toBe(join(first.dependency, "index.ts"));
  expect(effective(sourceTwo)).toBe(join(second.dependency, "index.ts"));
  expect(readFileSync(effective(sourceOne), "utf8")).toContain('selected = "first"');
  expect(readFileSync(effective(sourceTwo), "utf8")).toContain('selected = "second"');
  expect(fixtureGit(first.dependency, "rev-parse", "HEAD")).toBe(one.current.ompUlw.commit);
  expect(await installBundle(f.paths, second.bundle, two)).toEqual(two);
  expect(readFileSync(f.paths.config)).toEqual(config);
  expect(resolveConsumerOmpCommand(["/owner/custom-omp"], { home: f.paths.home, sourceRoot: sourceTwo })).toEqual([
    "/owner/custom-omp",
  ]);
  const rolled = await rollbackRelease(f.paths, two);
  expect(effective(sourceOne)).toBe(join(first.dependency, "index.ts"));
  expect(readFileSync(f.paths.config)).toEqual(config);
  writeFileSync(join(second.dependency, "index.ts"), "owner edit\n");
  expect(() => effective(sourceTwo)).toThrow();
  await expect(installBundle(f.paths, second.bundle, rolled)).rejects.toThrow();
  expect(readlinkSync(f.paths.live)).toBe(sourceOne);
});

test("rollback to a genuine older archive keeps its no-lock protocol instead of requiring new source locks", async () => {
  const f = fixture();
  const old = await installBundle(f.paths, f.release("older").bundle, undefined);
  const next = bundledRelease(f, "newer");
  const state = await installBundle(f.paths, next.bundle, old);
  expect(existsSync(join(f.paths.dori, "bin/omp"))).toBe(true);
  const restored = await rollbackRelease(f.paths, state);
  expect(restored.current.requirements.omp).toBe("18.18.8");
  expect(existsSync(join(f.paths.dori, "bin/omp"))).toBe(false);
});

test("a managed process selects its prepared default but retains an explicit external ULW path", () => {
  const before = process.env["DORI_OMP_ULW_PATH"];
  try {
    process.env["DORI_OMP_ULW_PATH"] = "/prepared/omp-ulw/index.ts";
    expect(resolveProcessOmpUlwPath("", "/home/fixture")).toBe("/prepared/omp-ulw/index.ts");
    expect(resolveProcessOmpUlwPath("/home/fixture/.dori/omp-ulw/index.ts", "/home/fixture")).toBe(
      "/prepared/omp-ulw/index.ts",
    );
    expect(resolveProcessOmpUlwPath("/owner/custom-ulw/index.ts", "/home/fixture")).toBe("/owner/custom-ulw/index.ts");
  } finally {
    if (before === undefined) delete process.env["DORI_OMP_ULW_PATH"];
    else process.env["DORI_OMP_ULW_PATH"] = before;
  }
});
