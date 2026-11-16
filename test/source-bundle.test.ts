import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOmpCommand } from "../skills/dori-mode/scripts/src/config.ts";
import { assertNativeSource, nativeDirectory } from "../src/release/native.ts";
import { assertSourceBundle, readSourceBundle } from "../src/release/source-bundle.ts";
import { provisionSourceOverlay } from "../src/release/source-checkout.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { carryDoriPin, digest, sourceManifest } from "../src/update/source.ts";
import { releaseFixture } from "./release-producer-setup.ts";
import { fixtureGit, nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";
import { setup } from "./install-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(native = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-source-bundle-")));
  roots.push(root);
  return { root, ...overlayFixture(join(root, "bundle"), join(root, "upstream"), native) };
}

test("the same upstream version and launcher bytes cannot satisfy a bound patched native source", () => {
  const f = fixture(true);
  const home = join(f.root, "home");
  const receipt = nativeCacheFixture(f.source, home, f.checkout);
  expect(assertNativeSource(f.source, home).identity).toBe(receipt.identity);
  expect(isOmpCommand([receipt.omp, "{prompt}"])).toBe(true);
  const launcher = readFileSync(receipt.omp);
  fixtureGit(join(receipt.directory, "source"), "restore", "--source=HEAD", "--staged", "--worktree", "index.ts");
  expect(readFileSync(receipt.omp)).toEqual(launcher);
  expect(readFileSync(join(receipt.directory, "source/packages/coding-agent/src/cli.ts"), "utf8")).toContain("18.20.0");
  expect(() => assertNativeSource(f.source, home)).toThrow("source checkout differs");
});

test("a version-only stock cache receipt cannot stand in for a source bundle", () => {
  const f = fixture(true);
  const home = join(f.root, "home");
  const directory = nativeDirectory(f.source, home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "receipt.json"), JSON.stringify({ version: 1, nativeVersion: "18.20.0" }), {
    mode: 0o600,
  });
  expect(() => assertNativeSource(f.source, home)).toThrow("receipt differs");
});

test("native postimage and unchanged upstream source drift are both refused", () => {
  const f = fixture(true);
  const home = join(f.root, "home");
  const receipt = nativeCacheFixture(f.source, home, f.checkout);
  const path = join(receipt.directory, "source/presets.ts");
  writeFileSync(path, "owner edit\n");
  expect(() => assertNativeSource(f.source, home)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("owner edit\n");
});

test("overlay provisioning keeps HEAD at the exact upstream and admits only the expected staged patch on reuse", async () => {
  const f = fixture();
  const target = join(f.root, "installed");
  expect(await provisionSourceOverlay(f.source, f.root, target, f.checkout)).toBe(join(target, "index.ts"));
  expect(fixtureGit(target, "rev-parse", "HEAD")).toBe(f.commit);
  expect(fixtureGit(target, "write-tree")).toBe(f.lock.resultTree);
  expect(readFileSync(join(target, "index.ts"), "utf8")).toContain("reviewed-overlay");
  expect(await provisionSourceOverlay(f.source, f.root, target, f.checkout)).toBe(join(target, "index.ts"));
  writeFileSync(join(target, "presets.ts"), "owner edit\n");
  await expect(provisionSourceOverlay(f.source, f.root, target, f.checkout)).rejects.toThrow();
  expect(readFileSync(join(target, "presets.ts"), "utf8")).toBe("owner edit\n");
});

test("a changed patch digest, malformed bound patch and partial install fail without a stock fallback", async () => {
  const f = fixture();
  writeFileSync(join(f.source, "omp-ulw.patch"), "not a patch\n");
  expect(() => readSourceBundle(f.source)).toThrow("patch digest differs");
  writeFileSync(
    join(f.source, "omp-ulw.overlay.lock"),
    JSON.stringify({ ...f.lock, patchSha256: digest("not a patch\n") }),
  );
  const target = join(f.root, "installed");
  await expect(provisionSourceOverlay(f.source, f.root, target, f.checkout)).rejects.toThrow();
  await expect(provisionSourceOverlay(f.source, f.root, target, f.checkout)).rejects.toThrow("Partial ULW preparation");
});

test("new release manifests cannot silently use the older no-lock protocol", () => {
  const old = releaseFixture();
  expect(validateReleaseManifest(old).requirements.omp).toBe("18.18.8");
  expect(() => validateReleaseManifest({ ...old, requirements: { ...old.requirements, omp: "18.20.0" } })).toThrow(
    "source bundle is incomplete",
  );
  const files = [{ path: "native-omp.lock", sha256: digest("{}"), executable: false }];
  expect(() => validateReleaseManifest(releaseFixture(files))).toThrow("older no-lock release protocol");
});

test.each(["primary", "side"])(
  "the %s source install selects the bound source instead of same-version PATH stock",
  (mode) => {
    const s = setup();
    const native = overlayFixture(s.src, join(s.root, "native-upstream"), true);
    const receipt = nativeCacheFixture(s.src, s.home, native.checkout);
    const result = s.install({ DORI_INSTALL_MODE: mode, DORI_OMP: "", DORI_NO_PULL: "1" });
    if (result.code !== 0) console.error(result.out, result.err);
    expect(result.code).toBe(0);
    const base = join(s.home, mode === "side" ? ".omp-dori" : ".dori");
    const config = JSON.parse(readFileSync(join(base, "config.json"), "utf8"));
    expect(config.agentCommand[0]).toBe(join(base, "bin/omp"));
    expect(readFileSync(join(base, "bin/omp"), "utf8")).toContain(receipt.omp);
    expect(assertNativeSource(s.src, s.home).identity).toBe(receipt.identity);
  },
);

test("a legitimate Git attribute checkout transform is admitted while real drift is still rejected", async () => {
  const f = fixture();
  const target = join(f.root, "installed");
  expect(await provisionSourceOverlay(f.source, f.root, target, f.checkout)).toBe(join(target, "index.ts"));
  const cmd = join(target, "crates/pi-shell/tests/fixtures/minimizer/cargo/test-pass.cmd");
  expect(readFileSync(cmd, "utf8")).toContain("\r\n");
  expect(fixtureGit(target, "rev-parse", "HEAD")).toBe(f.commit);
  expect(await provisionSourceOverlay(f.source, f.root, target, f.checkout)).toBe(join(target, "index.ts"));
  writeFileSync(cmd, "@echo off\r\nrem owner edit\r\n");
  await expect(provisionSourceOverlay(f.source, f.root, target, f.checkout)).rejects.toThrow(
    "differs from its upstream",
  );
  expect(readFileSync(cmd, "utf8")).toContain("owner edit");
});

test("assume-unchanged and skip-worktree cannot hide mutated tracked base content", async () => {
  const f = fixture();
  const target = join(f.root, "installed");
  expect(await provisionSourceOverlay(f.source, f.root, target, f.checkout)).toBe(join(target, "index.ts"));
  // A real BASE tracked path that this bundle's patch does not postimage; derived from Git, not assumed.
  // `.gitattributes` and `.gitignore` are the attribute/ignore authorities: editing either can legitimately
  // change how Git classifies other files, so both are excluded and the clean-view precondition below is
  // asserted rather than assumed.
  const postimages = new Set(f.lock.files.map((file) => file.path));
  const base = fixtureGit(target, "ls-tree", "-r", "--name-only", "HEAD")
    .split("\n")
    .filter((path) => path !== "" && path !== ".gitattributes" && path !== ".gitignore")
    .find((path) => !postimages.has(path));
  expect(base).toBeDefined();
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    fixtureGit(target, "update-index", flag, base!);
    writeFileSync(join(target, base!), `owner edit under ${flag}\n`);
    // Git's own status/tree views stay clean because the index flag hides the change.
    expect(fixtureGit(target, "diff-files", "--ignore-submodules=none", "--name-only")).toBe("");
    expect(fixtureGit(target, "write-tree")).toBe(f.lock.resultTree);
    expect(fixtureGit(target, "rev-parse", "HEAD")).toBe(f.commit);
    expect(() => assertSourceBundle(target, readSourceBundle(f.source), f.root)).toThrow("tracked content differs");
    fixtureGit(target, "update-index", "--no-assume-unchanged", base!);
    fixtureGit(target, "update-index", "--no-skip-worktree", base!);
    fixtureGit(target, "restore", "--source=HEAD", "--worktree", "--staged", base!);
  }
});

test("postimage assertions also reject a changed index even when the working bytes are unchanged", () => {
  const f = fixture();
  fixtureGit(f.checkout, "read-tree", "HEAD");
  expect(() => assertSourceBundle(f.checkout, readSourceBundle(f.source), f.root)).toThrow();
});

test("a Dori-only port carries native and ULW payloads as frozen source dependencies", () => {
  const f = fixture(true);
  overlayFixture(f.source, join(f.root, "ulw-upstream"));
  nativeCacheFixture(f.source, join(f.root, "home"), f.checkout);
  const candidate = join(f.root, "candidate");
  mkdirSync(candidate);
  carryDoriPin(f.source, candidate, sourceManifest(f.source));
  for (const path of [
    "native-omp.lock",
    "native-omp.patch",
    "native-addon/package.json",
    "native-addon/bun.lock",
    "omp-ulw.lock",
    "omp-ulw.overlay.lock",
    "omp-ulw.patch",
  ])
    expect(readFileSync(join(candidate, path))).toEqual(readFileSync(join(f.source, path)));
});

test("ignored untracked source is not admitted as an arbitrary dirty overlay", () => {
  const f = fixture();
  f.put("shadow.node", "unexpected ignored bytes\n");
  expect(() => assertSourceBundle(f.checkout, readSourceBundle(f.source), f.root)).toThrow("unexpected untracked");
});
