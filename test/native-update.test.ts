import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureNativeUpdate } from "../scripts/update-native-omp.ts";
import { readNativeArtifact } from "../src/release/native-update-artifact.ts";
import { NATIVE_UPDATE_FILES } from "../src/release/native-update-dependencies.ts";
import { latestNativeTag, prepareNativeUpdate } from "../src/release/native-update.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { checkoutSourceBundle } from "../src/release/source-checkout.ts";
import { fixtureGit } from "./source-bundle-setup.ts";
import { fixtureDependencyFiles, nativeUpdateFixture } from "./native-update-fixture.test.ts";

// POSIX-only: these fixtures require private mode bits, executable shebangs and /bin/sh Git admission.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("stable tags are numerically ordered, prereleases ignored and annotated tags peeled exactly", () => {
  const sha = "a".repeat(40);
  const peeled = "b".repeat(40);
  expect(
    latestNativeTag(
      [
        `${sha}\trefs/tags/v19.9.9`,
        `${sha}\trefs/tags/v19.10.0`,
        `${peeled}\trefs/tags/v19.10.0^{}`,
        `${sha}\trefs/tags/v20.0.0-rc.1`,
      ].join("\n"),
    ),
  ).toEqual({ tag: "v19.10.0", nativeVersion: "19.10.0", commit: peeled });
  expect(() => latestNativeTag(`${sha}\trefs/tags/v019.0.0`)).toThrow("No stable");
  expect(() => latestNativeTag(`${sha}\trefs/tags/v19.0.0\n${sha}\trefs/tags/19.0.0`)).toThrow("Ambiguous");
});

posix("unchanged release prepares nothing without touching the source or upstream overlay", async () => {
  const f = nativeUpdateFixture(roots);
  const before = fixtureGit(f.remote, "write-tree");
  expect(await prepareNativeUpdate(f.source, f.output, f.remote, fixtureDependencyFiles)).toBeUndefined();
  expect(existsSync(f.output)).toBe(false);
  expect(fixtureGit(f.remote, "write-tree")).toBe(before);
  expect(fixtureGit(f.source, "status", "--porcelain")).toBe("");
});

posix(
  "clean native apply carries exact overlay, source identity and all required pins into a draft artifact",
  async () => {
    const f = nativeUpdateFixture(roots);
    const original = NATIVE_UPDATE_FILES.map((path) => readFileSync(join(f.source, path)));
    const commit = f.advance();
    const candidate = await prepareNativeUpdate(f.source, f.output, f.remote, fixtureDependencyFiles);
    expect(candidate).toMatchObject({
      status: "candidate",
      commit,
      nativeVersion: "19.0.1",
      sourceCommit: f.sourceCommit,
    });
    expect(readNativeArtifact(f.source, f.output)).toEqual(candidate!);
    const selected = join(f.root, "verified-checkout");
    await checkoutSourceBundle(selected, readSourceBundle(f.output), f.root, f.remote);
    expect(readFileSync(join(selected, "index.ts"), "utf8")).toContain('selected = "reviewed-overlay"');
    expect(readFileSync(join(selected, "new-upstream.ts"), "utf8")).toContain("incoming = true");
    expect(NATIVE_UPDATE_FILES.map((path) => readFileSync(join(f.source, path)))).toEqual(original);
    expect(readdirSync(f.root).filter((name) => name.startsWith(".native-update-"))).toEqual([]);
    await expect(prepareNativeUpdate(f.source, f.output, f.remote, fixtureDependencyFiles)).rejects.toThrow(
      "already exists",
    );
  },
);

posix("three-way conflicts retain exact unresolved hunks in an artifact and do not refresh dependencies", async () => {
  const f = nativeUpdateFixture(roots);
  f.advance("19.0.1", true);
  let resolved = false;
  const result = await prepareNativeUpdate(f.source, f.output, f.remote, async () => {
    resolved = true;
  });
  expect(result?.status).toBe("conflict");
  const hunks = readFileSync(join(f.output, "conflicts.patch"), "utf8");
  expect(hunks).toContain("incoming");
  expect(hunks).toContain("reviewed-overlay");
  expect(hunks).toContain("<<<<<<<");
  expect(hunks).toStartWith("diff --cc index.ts\n");
  expect(hunks).toEndWith("\n");
  expect(readNativeArtifact(f.source, f.output)).toEqual(result!);
  expect(resolved).toBe(false);
  expect(fixtureGit(f.source, "status", "--porcelain")).toBe("");
});

posix("unsupported runtime major and failed frozen-lock refresh hold instead of metadata-only proposals", async () => {
  const major = nativeUpdateFixture(roots);
  major.advance("20.0.0");
  const held = await prepareNativeUpdate(major.source, major.output, major.remote, fixtureDependencyFiles);
  expect(held).toMatchObject({ status: "held", reason: "unsupported-runtime-major" });
  expect(readFileSync(join(major.output, "conflicts.patch"), "utf8")).toBe(major.old.patch);
  const dependency = nativeUpdateFixture(roots);
  dependency.advance();
  expect(
    await prepareNativeUpdate(dependency.source, dependency.output, dependency.remote, async () => {
      throw new Error("Synthetic registry failure");
    }),
  ).toMatchObject({ status: "held", reason: "dependency-lock-refresh-failed" });
  expect(readNativeArtifact(dependency.source, dependency.output).status).toBe("held");
});

posix("dirty source, invalid identity, mismatched version and rewritten tags are rejected", async () => {
  const dirty = nativeUpdateFixture(roots);
  dirty.advance();
  writeFileSync(join(dirty.source, "untracked.ts"), "preserve me");
  await expect(prepareNativeUpdate(dirty.source, dirty.output, dirty.remote, fixtureDependencyFiles)).rejects.toThrow(
    "clean",
  );
  const invalid = nativeUpdateFixture(roots);
  writeFileSync(join(invalid.source, "native-omp.patch"), "tampered");
  await expect(
    prepareNativeUpdate(invalid.source, invalid.output, invalid.remote, fixtureDependencyFiles),
  ).rejects.toThrow("digest");
  const moved = nativeUpdateFixture(roots);
  moved.advance();
  fixtureGit(moved.remote, "tag", "-f", "v19.0.0");
  fixtureGit(moved.remote, "tag", "-d", "v19.0.1");
  await expect(prepareNativeUpdate(moved.source, moved.output, moved.remote, fixtureDependencyFiles)).rejects.toThrow(
    "moved",
  );
  const mismatch = nativeUpdateFixture(roots);
  mismatch.advance();
  writeFileSync(join(mismatch.remote, "packages/coding-agent/package.json"), JSON.stringify({ version: "19.0.2" }));
  fixtureGit(mismatch.remote, "add", ".");
  fixtureGit(mismatch.remote, "commit", "--quiet", "-m", "Mismatched release package version");
  fixtureGit(mismatch.remote, "tag", "-f", "v19.0.1");
  await expect(
    prepareNativeUpdate(mismatch.source, mismatch.output, mismatch.remote, fixtureDependencyFiles),
  ).rejects.toThrow("package version differ");
});

posix("maintainer capture requires the exact staged checkout and package version", async () => {
  const f = nativeUpdateFixture(roots);
  const commit = f.advance();
  writeFileSync(join(f.remote, "index.ts"), 'export const selected = "reviewed-overlay";\n');
  fixtureGit(f.remote, "add", "index.ts");
  await expect(captureNativeUpdate(f.source, f.remote, "f".repeat(40), "19.0.1")).rejects.toThrow(
    "exact requested commit",
  );
  await expect(captureNativeUpdate(f.source, f.remote, commit, "19.0.2")).rejects.toThrow("package version");
  const result = await captureNativeUpdate(f.source, f.remote, commit, "19.0.1");
  expect(result).toMatchObject({ commit, version: "19.0.1" });
  expect(readSourceBundle(f.source).lock.nativeVersion).toBe("19.0.1");
});

posix("source movement during preparation is preserved and prevents emitting a candidate", async () => {
  const f = nativeUpdateFixture(roots);
  f.advance();
  await expect(
    prepareNativeUpdate(f.source, f.output, f.remote, (source, output, previous, next) => {
      fixtureDependencyFiles(source, output, previous, next);
      writeFileSync(join(source, "local-work.txt"), "keep this work");
    }),
  ).rejects.toThrow("exact clean");
  expect(readFileSync(join(f.source, "local-work.txt"), "utf8")).toBe("keep this work");
  expect(existsSync(f.output)).toBe(false);
});

posix("a same-major release removing the required launcher is held before refreshing pins", async () => {
  const f = nativeUpdateFixture(roots);
  f.advance();
  fixtureGit(f.remote, "rm", "--", "packages/coding-agent/scripts/omp");
  fixtureGit(f.remote, "commit", "--quiet", "-m", "Unsupported launcher layout");
  fixtureGit(f.remote, "tag", "-f", "v19.0.1");
  expect(await prepareNativeUpdate(f.source, f.output, f.remote, fixtureDependencyFiles)).toMatchObject({
    status: "held",
    reason: "unsupported-runtime-layout",
  });
  expect(readNativeArtifact(f.source, f.output).status).toBe("held");
});
