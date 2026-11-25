import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractArchive, readArchive } from "../src/release/archive.ts";
import type { VerifiedBundle } from "../src/release/bundle.ts";
import { type ConsumerPaths, pointer } from "../src/release/files.ts";
import { installBundle } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { archive, type ConsumerFixture, fixture, withArchive } from "./release-consumer-setup.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

/** A release bound to its own native identity, or to `nativeSource`'s; `populateSource` adds files before binding. */
export function boundRelease(
  f: ConsumerFixture,
  selected: string,
  nativeSource?: string,
  options: { version?: string; populateSource?: (source: string) => void } = {},
) {
  const original = f.release(selected);
  const source = join(f.root, `bound-${selected}`);
  extractArchive(original.bundle.files, original.bundle.manifest, source);
  options.populateSource?.(source);
  if (nativeSource) {
    for (const path of ["native-omp.lock", "native-omp.patch", "native-addon/package.json", "native-addon/bun.lock"])
      copyFileSync(join(nativeSource, path), join(source, path));
  } else {
    const native = overlayFixture(source, join(f.root, `native-${selected}`), selected, options.version);
    nativeCacheFixture(source, f.paths.home, native.checkout);
  }
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
      requirements: { omp: readSourceBundle(source).lock.nativeVersion },
    }),
    bytes,
  );
  return { source, bundle: { manifest, files: readArchive(bytes, manifest) } };
}

/** Publish a verified bundle's exact archive bytes and manifest as a local `--from` distribution directory. */
export function releaseDist(dist: string, bundle: VerifiedBundle): string {
  const { manifest } = bundle;
  const bytes = archive(
    bundle.files.map((file) => ({
      name: `${manifest.archive.root}/${file.path}`,
      bytes: Buffer.from(file.bytes),
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  if (digest(bytes) !== manifest.archive.sha256) throw new Error("Bundle archive bytes do not reproduce");
  const metadata = `${JSON.stringify(manifest, null, 2)}\n`;
  mkdirSync(dist, { mode: 0o700 });
  writeFileSync(join(dist, manifest.archive.name), bytes);
  writeFileSync(join(dist, "release-manifest.json"), metadata);
  writeFileSync(
    join(dist, "SHA256SUMS"),
    `${digest(bytes)}  ${manifest.archive.name}\n${digest(metadata)}  release-manifest.json\n`,
  );
  return dist;
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
          observed.push(pointer(join(paths.cataly, "bin/omp")));
          return blocked;
        }
        return paths.state;
      },
    },
  };
}

export async function activationFixture() {
  const f = fixture();
  const first = boundRelease(f, "first");
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
const paths = consumerPaths(home, join(home, ".cataly"));
const omp = join(paths.cataly, "bin/omp");
const target = releasePath(paths, after.current);
const native = join(target, "scripts/consumer/omp");
activateRelease({
  ...paths,
  get cataly() {
    if (phase === "journal" && existsSync(paths.journal)) process.exit(73);
    return paths.cataly;
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
