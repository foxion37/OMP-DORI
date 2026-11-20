import { expect, test } from "bun:test";
import { supportsReleaseProfile, validateReleaseManifest } from "../src/release/manifest.ts";
import { digest } from "../src/update/source.ts";
import { releaseFixture } from "./release-producer-setup.ts";

const linux = { platform: "linux", arch: "x64", runtime: "herdr" } as const;
const darwin = { platform: "darwin", arch: "arm64", runtime: "hc" } as const;

function bound(bytes: Uint8Array) {
  const fixture = releaseFixture();
  const files = [
    ...fixture.source.files,
    { path: "release-capabilities.json", sha256: digest(bytes), executable: false },
  ].sort((a, b) => a.path.localeCompare(b.path));
  return validateReleaseManifest({
    ...fixture,
    source: { ...fixture.source, files, hash: digest(JSON.stringify({ files, ulwPresent: false })) },
  });
}

test("legacy manifests preserve their schema and support only Linux", () => {
  const fixture = releaseFixture();
  const manifest = validateReleaseManifest(fixture);
  expect(manifest).toEqual(fixture);
  expect(supportsReleaseProfile(manifest, linux)).toBe(true);
  expect(supportsReleaseProfile(manifest, darwin)).toBe(false);
  expect(() => supportsReleaseProfile(manifest, linux, Buffer.from("{}"))).toThrow();
  expect(() => validateReleaseManifest({ ...fixture, capabilities: [darwin] })).toThrow();
});

test("source-bound metadata selects exact supported profiles", () => {
  const bytes = Buffer.from(JSON.stringify({ version: 1, profiles: [darwin] }));
  const manifest = bound(bytes);
  expect(supportsReleaseProfile(manifest, darwin, bytes)).toBe(true);
  expect(supportsReleaseProfile(manifest, linux, bytes)).toBe(false);
  expect(supportsReleaseProfile(manifest, { ...darwin, runtime: "herdr" }, bytes)).toBe(false);
  expect(() => supportsReleaseProfile(manifest, darwin)).toThrow();
  expect(() => supportsReleaseProfile(manifest, darwin, Buffer.from("{}"))).toThrow();
});

test.each([
  { value: undefined },
  { value: null },
  { value: {} },
  { value: { version: 2, profiles: [linux] } },
  { value: { version: 1, profiles: [] } },
  { value: { version: 1, profiles: [null] } },
  { value: { version: 1, profiles: [{ platform: "linux", arch: "x64" }] } },
  { value: { version: 1, profiles: [{ ...linux, extra: true }] } },
  { value: { version: 1, profiles: [{ ...linux, arch: "arm64" }] } },
  { value: { version: 1, profiles: [linux, linux] } },
  { value: { version: 1, profiles: [linux], extra: true } },
])("rejects malformed or duplicate source metadata: $value", ({ value }) => {
  const bytes = Buffer.from(JSON.stringify(value) ?? "undefined");
  expect(() => supportsReleaseProfile(bound(bytes), linux, bytes)).toThrow();
});
