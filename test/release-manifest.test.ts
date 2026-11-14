import { expect, test } from "bun:test";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { digest, sameManifest } from "../src/update/source.ts";
import { releaseFixture } from "./release-producer-setup.ts";

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
  "ref/omp-ulw/opaque.md",
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
  const manifest = releaseFixture([{ path, sha256: digest("private"), executable: false }]);
  expect(() => validateReleaseManifest(manifest)).toThrow();
});

test("rejects a source digest or executable-mode change not covered by the manifest hash", () => {
  const original = releaseFixture();
  for (const change of [{ sha256: digest("tampered") }, { executable: false }]) {
    const source = {
      ...original.source,
      files: [{ ...original.source.files[0]!, ...change }, original.source.files[1]!],
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

test("rejects opaque-library presence and arbitrary excluded operational files", () => {
  const manifest = releaseFixture();
  expect(() => validateReleaseManifest({ ...manifest, source: { ...manifest.source, ulwPresent: true } })).toThrow();
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

test("rejects a dependency source redirect, invalid pin and unsupported runtime", () => {
  const manifest = releaseFixture();
  for (const change of [{ repository: "https://example.test/omp-ulw.git" }, { commit: "HEAD" }]) {
    expect(() => validateReleaseManifest({ ...manifest, ompUlw: { ...manifest.ompUlw, ...change } })).toThrow();
  }
  expect(() =>
    validateReleaseManifest({
      ...manifest,
      requirements: { ...manifest.requirements, platform: "darwin" },
    }),
  ).toThrow("runtime");
});

test("rejects malformed digest, mode and unknown schema fields before extraction", () => {
  const manifest = releaseFixture();
  for (const change of [{ sha256: "x".repeat(64) }, { executable: 1 }, { link: "../outside" }]) {
    const files = [{ ...manifest.source.files[0]!, ...change }];
    expect(() => validateReleaseManifest({ ...manifest, source: { ...manifest.source, files } })).toThrow();
  }
  expect(() => validateReleaseManifest({ ...manifest, downloadUrl: "https://example.test/archive" })).toThrow();
});
