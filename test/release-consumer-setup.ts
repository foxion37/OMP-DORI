import { afterEach } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { VerifiedBundle } from "../src/release/bundle.ts";
import { readArchive } from "../src/release/archive.ts";
import { consumerPaths, initialize, saveJson } from "../src/release/files.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";

const roots: string[] = [];
afterEach(() => {
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

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: {
      PATH: process.env["PATH"],
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Consumer fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Consumer fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-consumer-")));
  roots.push(root);
  const paths = consumerPaths(join(root, "home"));
  initialize(paths);
  const dependency = join(root, "public-dependency-fixture");
  mkdirSync(dependency, { mode: 0o700 });
  writeFileSync(join(dependency, "index.ts"), "export default {};\n", { mode: 0o600 });
  git(dependency, "init", "--quiet");
  git(dependency, "add", "index.ts");
  git(dependency, "commit", "--quiet", "-m", "Isolated public dependency fixture");
  const pin = git(dependency, "rev-parse", "HEAD");
  const ownedDependency = join(paths.dependencies, `omp-ulw-${pin}`);
  renameSync(dependency, ownedDependency);
  saveJson(`${ownedDependency}.json`, {
    version: 1,
    repository: "https://github.com/dbc-hbin/omp-ulw.git",
    commit: pin,
  });
  let serial = 0;
  const release = (payload: string): { bundle: VerifiedBundle; bytes: Buffer; entries: TarEntry[]; dist: string } => {
    serial++;
    const releaseVersion = `1.2.${serial}`;
    const source = join(root, `source-${serial}`);
    mkdirSync(source, { mode: 0o700 });
    const contents: Record<string, string> = {
      "omp-ulw.lock": `${pin}\n`,
      "payload.txt": payload,
      "bin-entry.sh": "#!/bin/sh\nprintf 'release fixture\\n'\n",
      "skills/dori-mode/references/config.example.json": '{"runtime":"herdr","stateDir":"~/.dori/state"}\n',
    };
    for (const [path, bytes] of Object.entries(contents)) {
      mkdirSync(dirname(join(source, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(source, path), bytes, { mode: 0o600 });
    }
    chmodSync(join(source, "bin-entry.sh"), 0o755);
    const manifestSource = sourceManifest(source);
    const archiveRoot = `omp-dori-${releaseVersion}`;
    const entries = manifestSource.files.map((file) => ({
      name: `${archiveRoot}/${file.path}`,
      bytes: readFileSync(join(source, file.path)),
      mode: file.executable ? 0o755 : 0o644,
    }));
    const bytes = archive(entries);
    const manifest = validateReleaseManifest({
      version: 1,
      product: "omp-dori",
      releaseVersion,
      tag: `v${releaseVersion}`,
      commit: serial.toString(16).padStart(40, "0"),
      tree: "a".repeat(40),
      prerelease: true,
      archive: {
        name: `omp-dori-v${releaseVersion}.tar.gz`,
        root: archiveRoot,
        sha256: digest(bytes),
        bytes: bytes.length,
      },
      source: manifestSource,
      requirements: {
        platform: "linux",
        arch: "x64",
        bun: "1.4.4",
        omp: "18.18.8",
        runtime: "herdr",
        messenger: "discord",
      },
      ompUlw: { repository: "https://github.com/dbc-hbin/omp-ulw.git", commit: pin },
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
  return { root, paths, pin, ownedDependency, release };
}
