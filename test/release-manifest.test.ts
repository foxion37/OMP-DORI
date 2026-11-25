import { expect, test } from "bun:test";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { digest, sameManifest } from "../src/update/source.ts";
import type { SourceEntry } from "../src/update/types.ts";
import { releaseFixture } from "./release-producer-setup.ts";

const ordered = (files: SourceEntry[]): SourceEntry[] => files.sort((a, b) => (a.path < b.path ? -1 : 1));

test("accepts the existing public SourceManifest identity including executable files", () => {
  const expected = releaseFixture();
  expect(sameManifest(validateReleaseManifest(expected).source, expected.source)).toBe(true);
});

test.each([
  "../token",
  "/etc/passwd",
  "src/../../token",
  "src//file",
  "src/./file",
  "C:/token",
  "src\\token",
  "src/secret\0",
  "ref/upstream/opaque.md",
  "node_modules/tool/index.js",
  ".git/config",
  "state/state.json",
  "auth/session.json",
  "src/.env.live",
  "src/auth.json",
  "src/credentials.json",
  "src/private.pem",
  "src/private.key",
  "evidence/secrets.json",
])("rejects an unsafe or private path even with a matching source hash: %s", (path) => {
  const files = ordered([...releaseFixture().source.files, { path, sha256: digest("private"), executable: false }]);
  expect(() => validateReleaseManifest(releaseFixture(files))).toThrow();
});

test("rejects a source digest or executable-mode change not covered by the manifest hash", () => {
  const original = releaseFixture();
  for (const change of [{ sha256: digest("tampered") }, { executable: false }]) {
    const source = {
      ...original.source,
      files: original.source.files.map((file, i) => (i === 0 ? { ...file, ...change } : file)),
    };
    expect(() => validateReleaseManifest({ ...original, source })).toThrow("manifest hash");
  }
});

test.each(["duplicate", "order", "ancestor"])(
  "rejects conflicting source paths with recalculated identity: %s",
  (kind) => {
    const entry = { path: "src/cli.ts", sha256: digest("source"), executable: false };
    const files =
      kind === "duplicate"
        ? [entry, entry]
        : kind === "order"
          ? [{ ...entry, path: "z.ts" }, entry]
          : [{ ...entry, path: "src" }, entry];
    expect(() => validateReleaseManifest(releaseFixture(files))).toThrow("path");
  },
);

test("rejects unknown source fields and arbitrary excluded operational files", () => {
  const manifest = releaseFixture();
  expect(() => validateReleaseManifest({ ...manifest, source: { ...manifest.source, opaque: true } })).toThrow();
  expect(() =>
    validateReleaseManifest({ ...manifest, source: { ...manifest.source, excluded: ["auth.json"] } }),
  ).toThrow();
});

test.each([
  { tag: "v99.98.97" },
  { commit: "a".repeat(39) },
  { tree: "g".repeat(40) },
  { releaseVersion: "../outside" },
  { prerelease: "true" },
  { product: "other-product" },
])("rejects a release identity whose bindings do not match: %j", (change) => {
  expect(() => validateReleaseManifest({ ...releaseFixture(), ...change })).toThrow();
});

test.each([
  { name: "../payload.tar.gz" },
  { root: "../outside" },
  { sha256: "g".repeat(64) },
  { bytes: 0 },
  { bytes: -1 },
  { bytes: 1.5 },
  { bytes: Number.MAX_SAFE_INTEGER + 1 },
])("rejects unsafe archive metadata: %j", (change) => {
  const manifest = releaseFixture();
  expect(() => validateReleaseManifest({ ...manifest, archive: { ...manifest.archive, ...change } })).toThrow(
    "archive",
  );
});

test("requires a 19.x native OMP and no other requirement field", () => {
  const manifest = releaseFixture();
  expect(validateReleaseManifest(manifest).requirements).toEqual({ omp: "19.0.1" });
  for (const omp of ["18.20.0", "18.18.8", "20.0.0", "19.0.1-rc.1", "19.01.0"])
    expect(() => validateReleaseManifest({ ...manifest, requirements: { omp } })).toThrow("runtime");
  expect(() =>
    validateReleaseManifest({ ...manifest, requirements: { ...manifest.requirements, platform: "linux" } }),
  ).toThrow("requirements");
});

test("binds schema version 2 and the cataly archive identity", () => {
  const manifest = releaseFixture();
  expect(() => validateReleaseManifest({ ...manifest, version: 1 })).toThrow("identity");
  expect(() => validateReleaseManifest({ ...manifest, product: "omp-cataly" })).toThrow("identity");
  const { releaseVersion } = manifest;
  for (const archive of [{ name: `other-v${releaseVersion}.tar.gz` }, { root: `other-${releaseVersion}` }])
    expect(() => validateReleaseManifest({ ...manifest, archive: { ...manifest.archive, ...archive } })).toThrow(
      "archive",
    );
});

test.each([
  "native-omp.lock",
  "native-omp.patch",
  "native-addon/package.json",
  "native-addon/bun.lock",
  "release-headless.json",
  "scripts/source-dependencies.ts",
  "scripts/previous-install/cli.ts",
  "scripts/consumer/omp",
])("rejects a release without its bound native payload file %s", (path) => {
  const files = releaseFixture().source.files.filter((file) => file.path !== path);
  expect(() => validateReleaseManifest(releaseFixture(files))).toThrow(`incomplete: ${path}`);
});

test("rejects a non-executable consumer OMP wrapper", () => {
  const files = releaseFixture().source.files.map((file) =>
    file.path === "scripts/consumer/omp" ? { ...file, executable: false } : file,
  );
  expect(() => validateReleaseManifest(releaseFixture(files))).toThrow("must be executable");
});

test("rejects malformed digest, mode and unknown schema fields before extraction", () => {
  const manifest = releaseFixture();
  for (const change of [{ sha256: "x".repeat(64) }, { executable: 1 }, { link: "../outside" }]) {
    const files = manifest.source.files.map((file, i) => (i === 0 ? { ...file, ...change } : file));
    expect(() => validateReleaseManifest({ ...manifest, source: { ...manifest.source, files } })).toThrow();
  }
  expect(() => validateReleaseManifest({ ...manifest, downloadUrl: "https://example.test/archive" })).toThrow();
});
