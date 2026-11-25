import { expect, test } from "bun:test";
import { headlessReleaseProfiles } from "../src/release/capabilities.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { digest } from "../src/update/source.ts";
import { releaseFixture } from "./release-producer-setup.ts";

const linux = { platform: "linux", arch: "x64", runtime: "headless" } as const;
const darwin = { platform: "darwin", arch: "arm64", runtime: "headless" } as const;

function bound(bytes: Uint8Array): ReleaseManifest {
  const fixture = releaseFixture();
  const files = fixture.source.files.map((file) =>
    file.path === "release-headless.json" ? { ...file, sha256: digest(bytes) } : file,
  );
  return { ...fixture, source: { ...fixture.source, files, hash: digest(JSON.stringify({ files })) } };
}

test("source-bound metadata selects exact headless profiles", () => {
  const bytes = Buffer.from(JSON.stringify({ version: 1, profiles: [darwin, linux] }));
  expect(headlessReleaseProfiles(bound(bytes), bytes)).toEqual([darwin, linux]);
  expect(() => headlessReleaseProfiles(bound(bytes))).toThrow("SHA256");
  expect(() => headlessReleaseProfiles(bound(bytes), Buffer.from("{}"))).toThrow("SHA256");
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
  { value: { version: 1, profiles: [{ ...linux, runtime: "tern" }] } },
  { value: { version: 1, profiles: [{ ...darwin, runtime: "native" }] } },
  { value: { version: 1, profiles: [linux, linux] } },
  { value: { version: 1, profiles: [linux], extra: true } },
])("rejects malformed, non-headless or duplicate source metadata: $value", ({ value }) => {
  const bytes = Buffer.from(JSON.stringify(value) ?? "undefined");
  expect(() => headlessReleaseProfiles(bound(bytes), bytes)).toThrow();
});
