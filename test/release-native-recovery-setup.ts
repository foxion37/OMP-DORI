import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractArchive, readArchive } from "../src/release/archive.ts";
import { type ConsumerPaths, pointer, saveJson } from "../src/release/files.ts";
import { installBundle } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { sourceManifest } from "../src/update/source.ts";
import { archive, type ConsumerFixture, fixture, withArchive } from "./release-consumer-setup.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

export function boundRelease(f: ConsumerFixture, selected: string, nativeSource?: string) {
  const original = f.release(selected);
  const source = join(f.root, `bound-${selected}`);
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
  return { source, bundle: { manifest, files: readArchive(bytes, manifest) } };
}

export function blockStatePublication(paths: ConsumerPaths, root: string, target: string) {
  const blocked = join(root, "blocked-state-directory");
  mkdirSync(blocked, { mode: 0o700 });
  const observed: (string | undefined)[] = [];
  return {
    observed,
    paths: {
      ...paths,
      get state() {
        if (observed.length === 0 && pointer(paths.live) === target) {
          observed.push(pointer(join(paths.dori, "bin/omp")));
          return blocked;
        }
        return paths.state;
      },
    },
  };
}

export async function activationFixture(legacy: boolean) {
  const f = fixture();
  const first = legacy ? { source: undefined, bundle: f.release("legacy").bundle } : boundRelease(f, "first");
  const one = await installBundle(f.paths, first.bundle, undefined);
  const second = boundRelease(f, "second", first.source);
  const before = await installBundle(f.paths, second.bundle, one);
  const after = { version: 1 as const, current: one.current, previous: before.current };
  return { f, before, after, bundle: second.bundle };
}

export const interruptedActivation = `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { consumerPaths, pointer } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/files.ts"))};
import { activateRelease, loadInstalled, releasePath } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/state.ts"))};
const { home, before, after, phase } = JSON.parse(process.argv[1]);
const paths = consumerPaths(home);
const omp = join(paths.dori, "bin/omp");
const target = releasePath(paths, after.current);
const native = after.current.requirements.omp === "18.20.0" ? join(target, "scripts/consumer/omp") : undefined;
activateRelease({
  ...paths,
  get dori() {
    if (phase === "journal" && existsSync(paths.journal)) process.exit(73);
    return paths.dori;
  },
  get live() {
    if (phase === "native" && existsSync(paths.journal) && pointer(omp) === native) process.exit(73);
    return paths.live;
  },
  get state() {
    if (phase === "source" && pointer(paths.live) === target) process.exit(73);
    return paths.state;
  },
  get journal() {
    if (phase === "state" && loadInstalled(paths)?.current.commit === after.current.commit) process.exit(73);
    return paths.journal;
  },
}, before, after);
process.exit(99);
`;
