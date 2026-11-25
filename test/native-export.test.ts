import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertNativeExport } from "../src/release/native-export.ts";
import { assertNativeSource, provisionNativeSource } from "../src/release/native.ts";
import { assertSourceBundle, readSourceBundle } from "../src/release/source-bundle.ts";
import { digest } from "../src/update/source.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

// POSIX-only: native admission fixtures build private directories that POSIX mode bits mark.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// These are real Git/receipt admission consumers with explicitly synthetic viewer/addon bytes.
// Exact upstream generation and usable exported HTML are separate real consumer installation checks.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-native-export-")));
  roots.push(root);
  const upstream = overlayFixture(join(root, "bundle"), join(root, "upstream"));
  const home = join(root, "home");
  const receipt = nativeCacheFixture(upstream.source, home, upstream.checkout);
  const checkout = join(receipt.directory, "source");
  const assets = join(checkout, "packages/coding-agent/export-assets");
  const manifestPath = join(checkout, "packages/coding-agent/src/export/html/viewer.generated.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const viewer = join(assets, manifest.file);
  const bundle = readSourceBundle(upstream.source);
  return { root, source: upstream.source, home, receipt, checkout, assets, manifestPath, manifest, viewer, bundle };
}
type Fixture = {
  readonly root: string;
  readonly assets: string;
  readonly viewer: string;
  readonly manifestPath: string;
  readonly manifest: { readonly file: string; readonly integrity: string; readonly size: number };
};

posix("exact manifest-authenticated export assets pass generic, native and existing-cache admission", async () => {
  const f = fixture();
  expect(assertNativeExport(f.checkout)).toBe(true);
  expect(() => assertSourceBundle(f.checkout, f.bundle, f.home)).not.toThrow();
  expect(assertNativeSource(f.source, f.home)).toEqual(f.receipt);
  expect(await provisionNativeSource(f.source, f.home)).toEqual(f.receipt);
});

posix("source may precede generation, but native reuse holds incomplete caches unchanged", async () => {
  const f = fixture();
  const receiptPath = join(f.receipt.directory, "receipt.json");
  const receipt = readFileSync(receiptPath);
  const manifest = readFileSync(f.manifestPath);
  rmSync(f.assets, { recursive: true });
  expect(assertNativeExport(f.checkout, false)).toBe(false);
  expect(() => assertSourceBundle(f.checkout, f.bundle, f.home)).not.toThrow();
  expect(() => assertNativeSource(f.source, f.home)).toThrow("export viewer is missing");
  await expect(provisionNativeSource(f.source, f.home)).rejects.toThrow("export viewer is missing");
  expect(existsSync(f.assets)).toBe(false);
  expect(readFileSync(receiptPath)).toEqual(receipt);
  expect(readFileSync(f.manifestPath)).toEqual(manifest);
});

posix.each([
  [
    "same-size viewer tamper",
    (f: Fixture) => {
      const bytes = readFileSync(f.viewer);
      bytes[0] = bytes[0]! ^ 1;
      writeFileSync(f.viewer, bytes);
    },
  ],
  ["truncated viewer", (f: Fixture) => writeFileSync(f.viewer, readFileSync(f.viewer).subarray(1))],
  ["missing viewer in existing assets directory", (f: Fixture) => rmSync(f.viewer)],
  ["extra asset", (f: Fixture) => writeFileSync(join(f.assets, "extra.js"), "extra\n", { mode: 0o600 })],
  ["nested assets", (f: Fixture) => mkdirSync(join(f.assets, "nested"), { mode: 0o700 })],
  [
    "viewer symlink",
    (f: Fixture) => {
      const target = join(f.root, "viewer-copy.js");
      renameSync(f.viewer, target);
      symlinkSync(target, f.viewer);
    },
  ],
  [
    "assets directory symlink",
    (f: Fixture) => {
      const target = join(f.root, "assets-copy");
      renameSync(f.assets, target);
      symlinkSync(target, f.assets);
    },
  ],
  ["writable viewer", (f: Fixture) => chmodSync(f.viewer, 0o666)],
  ["writable assets directory", (f: Fixture) => chmodSync(f.assets, 0o777)],
  ["writable assets ancestor", (f: Fixture) => chmodSync(dirname(f.assets), 0o777)],
  ["writable manifest", (f: Fixture) => chmodSync(f.manifestPath, 0o666)],
  ["writable manifest ancestor", (f: Fixture) => chmodSync(dirname(f.manifestPath), 0o777)],
  [
    "manifest symlink",
    (f: Fixture) => {
      const target = join(f.root, "manifest-copy.json");
      renameSync(f.manifestPath, target);
      symlinkSync(target, f.manifestPath);
    },
  ],
] as const)("export admission rejects %s", (_name, mutate) => {
  const f = fixture();
  mutate(f);
  expect(() => assertNativeExport(f.checkout, false)).toThrow();
  expect(() => assertSourceBundle(f.checkout, f.bundle, f.home)).toThrow();
  expect(() => assertNativeSource(f.source, f.home)).toThrow();
});

posix.each([
  ["path traversal", (f: Fixture) => ({ ...f.manifest, file: "../viewer.js" })],
  ["wrong SRI", (f: Fixture) => ({ ...f.manifest, integrity: "sha256-wrong" })],
  ["wrong size", (f: Fixture) => ({ ...f.manifest, size: f.manifest.size + 1 })],
  ["extra metadata key", (f: Fixture) => ({ ...f.manifest, extra: true })],
] as const)("export manifest admission rejects %s", (_name, metadata) => {
  const f = fixture();
  writeFileSync(f.manifestPath, JSON.stringify(metadata(f)));
  expect(() => assertNativeExport(f.checkout)).toThrow();
  expect(() => assertSourceBundle(f.checkout, f.bundle, f.home)).toThrow();
  expect(() => assertNativeSource(f.source, f.home)).toThrow();
});

posix("matching new viewer metadata cannot replace the authenticated tracked manifest", () => {
  const f = fixture();
  const bytes = "different admission fixture bytes\n";
  const hash = digest(bytes);
  const manifest = {
    file: `export-viewer-${hash}.js`,
    integrity: `sha256-${Buffer.from(hash, "hex").toString("base64")}`,
    size: Buffer.byteLength(bytes),
  };
  rmSync(f.viewer);
  writeFileSync(join(f.assets, manifest.file), bytes, { mode: 0o600 });
  writeFileSync(f.manifestPath, JSON.stringify(manifest));
  expect(assertNativeExport(f.checkout)).toBe(true);
  expect(() => assertSourceBundle(f.checkout, f.bundle, f.home)).toThrow();
  expect(() => assertNativeSource(f.source, f.home)).toThrow();
});

posix("valid export assets do not exempt unrelated untracked source or non-native bundles", () => {
  const f = fixture();
  writeFileSync(join(f.checkout, "shadow.node"), "untracked source\n", { mode: 0o600 });
  expect(assertNativeExport(f.checkout)).toBe(true);
  expect(() => assertSourceBundle(f.checkout, f.bundle, f.home)).toThrow("unexpected untracked");
  expect(() => assertNativeSource(f.source, f.home)).toThrow("unexpected untracked");
});
