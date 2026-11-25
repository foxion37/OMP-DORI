import { afterEach, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { VerifiedBundle } from "../src/release/bundle.ts";
import { readArchive } from "../src/release/archive.ts";
import { type ConsumerPaths, consumerPaths, initialize } from "../src/release/files.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { nativeDirectory } from "../src/release/native.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
export const posix = test.skipIf(process.platform === "win32");

const DEPENDENCIES = resolve(import.meta.dir, "../scripts/source-dependencies.ts");
const roots: string[] = [];
const environmentKeys = [
  "HOME",
  "PATH",
  "CATALY_HOME",
  "CATALY_CONFIG",
  "CATALY_STATE_DIR",
  "CATALY_AGENT_CMD",
  "CATALY_AGENT_ARGV",
];
const environment = new Map<string, string | undefined>();
afterEach(() => {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  environment.clear();
  for (const root of roots.splice(0)) {
    const writable = (path: string) => {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) writable(join(path, entry.name));
      }
    };
    writable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

export type TarEntry = {
  readonly name: string;
  readonly bytes?: string | Buffer;
  readonly kind?: string;
  readonly mode?: number;
};
export function archive(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    const number = (value: number, offset: number, length: number) =>
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
    number(entry.mode ?? 0o644, 100, 8);
    number(0, 108, 8);
    number(0, 116, 8);
    number(bytes.length, 124, 12);
    number(0, 136, 12);
    header.fill(32, 148, 156);
    header.write(entry.kind ?? "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    parts.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export function withArchive(manifest: ReleaseManifest, bytes: Buffer): ReleaseManifest {
  return validateReleaseManifest({
    ...manifest,
    archive: { ...manifest.archive, sha256: digest(bytes), bytes: bytes.length },
  });
}

export type ConsumerFixture = {
  readonly root: string;
  readonly paths: ConsumerPaths;
  /** `launcher` replaces the release's own `scripts/consumer/omp`, which the isolated `bin/omp` wrapper execs. */
  /** Rebuild the shared native cache fixture for another Bun executable; the receipt binds exactly one. */
  readonly rebindNative: (bun: string) => void;
  readonly release: (
    payload: string,
    launcher?: string,
  ) => { bundle: VerifiedBundle; bytes: Buffer; entries: TarEntry[]; dist: string };
};

/** Every release carries these exact bound native payload files, taken from one shared native fixture per home. */
const NATIVE_FILES = [
  "native-omp.lock",
  "native-omp.patch",
  "native-addon/package.json",
  "native-addon/bun.lock",
  "scripts/source-dependencies.ts",
] as const;

/** A primary consumer, or with `side` a custom home beside it; both install real native-bound v2 releases. */
export function fixture(side = false): ConsumerFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-consumer-")));
  roots.push(root);
  const home = join(root, "home");
  const paths = consumerPaths(home, join(home, side ? ".cataly-side" : ".cataly"));
  for (const key of environmentKeys) {
    if (!environment.has(key)) environment.set(key, process.env[key]);
  }
  process.env["HOME"] = paths.home;
  process.env["CATALY_HOME"] = paths.cataly;
  process.env["CATALY_CONFIG"] = paths.config;
  process.env["CATALY_STATE_DIR"] = join(paths.cataly, "state");
  delete process.env["CATALY_AGENT_CMD"];
  delete process.env["CATALY_AGENT_ARGV"];
  initialize(paths);
  const template = join(root, "native-template");
  const upstream = join(root, "native-upstream");
  let native: string | undefined;
  const nativeTemplate = (): string => {
    if (native) return native;
    overlayFixture(template, upstream);
    mkdirSync(join(template, "scripts"), { mode: 0o700 });
    copyFileSync(DEPENDENCIES, join(template, "scripts/source-dependencies.ts"));
    nativeCacheFixture(template, paths.home, upstream);
    return (native = template);
  };
  const rebindNative = (bun: string): void => {
    const directory = nativeDirectory(nativeTemplate(), paths.home);
    rmSync(directory, { recursive: true, force: true });
    nativeCacheFixture(template, paths.home, upstream, directory, bun);
  };
  let serial = 0;
  const release = (
    payload: string,
    launcher?: string,
  ): { bundle: VerifiedBundle; bytes: Buffer; entries: TarEntry[]; dist: string } => {
    serial++;
    const releaseVersion = `1.2.${serial}`;
    const source = join(root, `source-${serial}`);
    mkdirSync(source, { mode: 0o700 });
    const contents: Record<string, string | Buffer> = {
      "payload.txt": payload,
      "skills/cataly-mode/SKILL.md": `---\nname: cataly-mode\ndescription: Cataly commands\n---\nRelease skill\n${payload}`,
      "bin-entry.sh": "#!/bin/sh\nprintf 'release fixture\\n'\n",
      // The isolated bin/omp wrapper asks the loaded release which source to launch; fixtures keep their own.
      "src/release/automatic.ts": "console.log(process.argv[2]);\n",
      "src/release/references.ts": `export { installIsolatedReferences } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/references.ts"))};\n`,
      "skills/cataly-mode/references/config.example.json": '{"stateDir":"~/.cataly/state"}\n',
      "release-headless.json": readFileSync(resolve(import.meta.dir, "../release-headless.json")),
      "scripts/consumer/omp": launcher ?? readFileSync(resolve(import.meta.dir, "../scripts/consumer/omp")),
      // A release carries the installer's one-way bridge from previous installations.
      "scripts/previous-install/cli.ts": "export {};\n",
    };
    for (const path of NATIVE_FILES) contents[path] = readFileSync(join(nativeTemplate(), path));
    for (const [path, bytes] of Object.entries(contents)) {
      mkdirSync(dirname(join(source, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(source, path), bytes, { mode: 0o600 });
    }
    chmodSync(join(source, "bin-entry.sh"), 0o755);
    chmodSync(join(source, "scripts/consumer/omp"), 0o755);
    const manifestSource = sourceManifest(source);
    const archiveRoot = `cataly-${releaseVersion}`;
    const entries = manifestSource.files.map((file) => ({
      name: `${archiveRoot}/${file.path}`,
      bytes: readFileSync(join(source, file.path)),
      mode: file.executable ? 0o755 : 0o644,
    }));
    const bytes = archive(entries);
    const manifest = validateReleaseManifest({
      version: 2,
      product: "cataly",
      releaseVersion,
      tag: `v${releaseVersion}`,
      commit: serial.toString(16).padStart(40, "0"),
      tree: "a".repeat(40),
      prerelease: true,
      archive: {
        name: `cataly-v${releaseVersion}.tar.gz`,
        root: archiveRoot,
        sha256: digest(bytes),
        bytes: bytes.length,
      },
      source: manifestSource,
      requirements: { omp: readSourceBundle(source).lock.nativeVersion },
    });
    const dist = join(root, `dist-${serial}`);
    mkdirSync(dist, { mode: 0o700 });
    writeFileSync(join(dist, manifest.archive.name), bytes, { mode: 0o600 });
    const metadata = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(dist, "release-manifest.json"), metadata, { mode: 0o600 });
    writeFileSync(
      join(dist, "SHA256SUMS"),
      `${digest(bytes)}  ${manifest.archive.name}\n${digest(metadata)}  release-manifest.json\n`,
      { mode: 0o600 },
    );
    return { bundle: { manifest, files: readArchive(bytes, manifest) }, bytes, entries, dist };
  };
  return { root, paths, rebindNative, release };
}
