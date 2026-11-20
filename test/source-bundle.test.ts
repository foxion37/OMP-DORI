import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOmpArgv } from "../src/runtime/omp-argv.ts";
import { assertNativeSource, nativeDirectory } from "../src/release/native.ts";
import { assertSourceBundle, readSourceBundle } from "../src/release/source-bundle.ts";
import { provisionSourceOverlay } from "../src/release/source-checkout.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { carryDoriPin, digest, sourceManifest } from "../src/update/source.ts";
import { releaseFixture } from "./release-producer-setup.ts";
import { fixtureGit, nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";
import { posix, setup } from "./install-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(native = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-source-bundle-")));
  roots.push(root);
  return { root, ...overlayFixture(join(root, "bundle"), join(root, "upstream"), native) };
}

posix("the same upstream version and launcher bytes cannot satisfy a bound patched native source", () => {
  const f = fixture(true);
  const home = join(f.root, "home");
  const receipt = nativeCacheFixture(f.source, home, f.checkout);
  expect(assertNativeSource(f.source, home).identity).toBe(receipt.identity);
  expect(isOmpArgv([receipt.omp, "{prompt}"])).toBe(true);
  const launcher = readFileSync(receipt.omp);
  fixtureGit(join(receipt.directory, "source"), "restore", "--source=HEAD", "--staged", "--worktree", "index.ts");
  expect(readFileSync(receipt.omp)).toEqual(launcher);
  expect(readFileSync(join(receipt.directory, "source/packages/coding-agent/src/cli.ts"), "utf8")).toContain("18.20.0");
  expect(() => assertNativeSource(f.source, home)).toThrow("source checkout differs");
});

posix("a version-only stock cache receipt cannot stand in for a source bundle", () => {
  const f = fixture(true);
  const home = join(f.root, "home");
  const directory = nativeDirectory(f.source, home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "receipt.json"), JSON.stringify({ version: 1, nativeVersion: "18.20.0" }), {
    mode: 0o600,
  });
  expect(() => assertNativeSource(f.source, home)).toThrow("receipt differs");
});

posix("native postimage and unchanged upstream source drift are both refused", () => {
  const f = fixture(true);
  const home = join(f.root, "home");
  const receipt = nativeCacheFixture(f.source, home, f.checkout);
  const path = join(receipt.directory, "source/presets.ts");
  writeFileSync(path, "owner edit\n");
  expect(() => assertNativeSource(f.source, home)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("owner edit\n");
});
const t = "overlay provisioning keeps HEAD at the exact upstream and admits only the expected staged patch on reuse";
posix(t, async () => {
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

posix("a changed patch digest, malformed bound patch and partial install fail without a stock fallback", async () => {
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

posix.each(["primary", "side"])(
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

posix("a legitimate Git attribute checkout transform is admitted while real drift is still rejected", async () => {
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

posix("assume-unchanged and skip-worktree cannot hide mutated tracked base content", async () => {
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

posix("concurrent guards leave the shared index alone and still reject real content changes", async () => {
  const f = fixture();
  const index = join(f.checkout, ".git/index");
  const before = readFileSync(index);
  // Hold a writer's lock so the regression fails deterministically, not just when children race.
  const lock = join(f.checkout, ".git/index.lock");
  writeFileSync(lock, "another writer\n", { flag: "wx" });
  const code = `
    const { assertSourceBundle, readSourceBundle } = await import(${JSON.stringify(
      join(import.meta.dir, "../src/release/source-bundle.ts"),
    )});
    assertSourceBundle(process.argv[1], readSourceBundle(process.argv[2]), process.argv[3]);
  `;
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, "-e", code, f.checkout, f.source, f.root], { stdout: "pipe", stderr: "pipe" }),
  );
  const results = await Promise.all(
    children.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })),
  );
  expect(results).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stderr: "" })));
  expect(readFileSync(index)).toEqual(before);
  expect(readFileSync(lock, "utf8")).toBe("another writer\n");
  f.put("presets.ts", "owner edit\n");
  expect(() => assertSourceBundle(f.checkout, readSourceBundle(f.source), f.root)).toThrow("source checkout differs");
});

posix("Git failures name the command, exit code and stderr", () => {
  const f = fixture();
  writeFileSync(join(f.checkout, ".git/HEAD"), "ref: refs/heads/missing\n");
  expect(() => assertSourceBundle(f.checkout, readSourceBundle(f.source), f.root)).toThrow(
    /git rev-parse HEAD exited 128: fatal: ambiguous argument 'HEAD'/,
  );
});

posix("a Dori-only port carries native and ULW payloads as frozen source dependencies", () => {
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

posix("ignored untracked source is not admitted as an arbitrary dirty overlay", () => {
  const f = fixture();
  f.put("shadow.node", "unexpected ignored bytes\n");
  expect(() => assertSourceBundle(f.checkout, readSourceBundle(f.source), f.root)).toThrow("unexpected untracked");
});

posix("batched content hashes preserve path order and reject hidden drift in a later batch", () => {
  const f = fixture();
  for (let at = 0; at < 1024; at++)
    f.put(`bulk/${String(at).padStart(4, "0")}.cmd`, `@echo off\r\nrem unique content ${at}\r\n`);
  f.put(".gitattributes", "*.cmd text eol=crlf\nbulk/0000.cmd filter=slow\n");
  // Delay the first batch's real clean filter so later batches can finish first.
  fixtureGit(f.checkout, "config", "filter.slow.clean", "sleep 0.1; cat");
  fixtureGit(f.checkout, "add", ".");
  const bundle = {
    ...readSourceBundle(f.source),
    lock: { ...f.lock, resultTree: fixtureGit(f.checkout, "write-tree") },
  };
  // Every file has a distinct blob; concatenating completion order would reject this clean tree.
  expect(() => assertSourceBundle(f.checkout, bundle, f.root)).not.toThrow();
  const later = "bulk/1023.cmd";
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    fixtureGit(f.checkout, "update-index", flag, later);
    f.put(later, `@echo off\r\nrem hidden edit under ${flag}\r\n`);
    expect(fixtureGit(f.checkout, "diff-files", "--ignore-submodules=none", "--name-only")).toBe("");
    expect(fixtureGit(f.checkout, "write-tree")).toBe(bundle.lock.resultTree);
    expect(() => assertSourceBundle(f.checkout, bundle, f.root)).toThrow("tracked content differs");
    fixtureGit(f.checkout, "update-index", "--no-assume-unchanged", later);
    fixtureGit(f.checkout, "update-index", "--no-skip-worktree", later);
    fixtureGit(f.checkout, "restore", "--worktree", later);
  }
  fixtureGit(f.checkout, "update-index", "--assume-unchanged", "bulk/0000.cmd");
  fixtureGit(f.checkout, "config", "filter.slow.required", "true");
  fixtureGit(f.checkout, "config", "filter.slow.clean", "exit 1");
  expect(() => assertSourceBundle(f.checkout, bundle, f.root)).toThrow(/hash-object --stdin-paths exited 128: error:/);
});
