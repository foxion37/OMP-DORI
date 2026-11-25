import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { treeNativeBinaries } from "../src/native-binary.ts";
import { prepareNativeHost } from "../src/update/deployment-native.ts";
import { prepareRelease } from "../src/update/deployment-prepare.ts";
import { DeploymentHeld } from "../src/update/deployment-process.ts";
import { sourceManifest } from "../src/update/source.ts";
import { preparationFixture } from "./update-deploy-prepare-setup.ts";

// POSIX-only: preparation runs Cargo through `/bin/sh -c 'umask 077; exec "$@"'`.
const it = test.skipIf(process.platform === "win32");
const crate = { "Cargo.toml": '[package]\nname = "cataly"\n' };
const path = process.env["PATH"];
afterEach(() => {
  process.env["PATH"] = path;
});

/** A recording stand-in for `cargo build`: it writes an executable into the requested target directory. */
function fakeCargo(dir: string, fails = false): string {
  const bin = join(dir, "fake-cargo-bin");
  const log = join(dir, "cargo.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "cargo"),
    `#!/bin/sh
{ printf 'cwd=%s\\n' "$PWD"; printf 'umask=%s\\n' "$(umask)"; printf 'env=%s\\n' "$CARGO_HOME" "$CARGO_INCREMENTAL"
  for arg in "$@"; do printf 'arg=%s\\n' "$arg"; done; } >> ${JSON.stringify(log)}
${fails ? "exit 101" : ""}
while [ $# -gt 0 ]; do [ "$1" = --target-dir ] && target=$2; shift; done
mkdir -p "$target/release" && printf '#!/bin/sh\\n' > "$target/release/cataly" && chmod 700 "$target/release/cataly"
`,
    { mode: 0o755 },
  );
  // Preparation runs whatever cargo the deployment process's PATH names.
  process.env["PATH"] = `${bin}:/usr/bin:/bin`;
  return log;
}

it("a crate release is built into its own manifest-omitted target before any native effect", async () => {
  const f = preparationFixture(crate);
  const log = fakeCargo(f.directory);
  await prepareRelease(f.config, f.input, f.record);
  const release = f.record.releasePath;
  const [, built] = treeNativeBinaries(release);
  expect(lstatSync(built).isFile()).toBe(true);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "cwd=/",
    "umask=0077",
    `env=${join(f.record.directory, "cargo-home")}`,
    "env=0",
    ...["build", "--manifest-path", join(release, "Cargo.toml"), "--locked", "--release", "--bin", "cataly"].map(
      (arg) => `arg=${arg}`,
    ),
    "arg=--target-dir",
    `arg=${join(release, "target", "managed")}`,
  ]);
  // The build output is not reviewed source; the prepared tree still matches the candidate.
  expect(sourceManifest(release).hash).toBe(f.input.sourceHash);
  expect(lstatSync(f.config.liveSource, { throwIfNoEntry: false })).toBeUndefined();
});

it("a release without a Rust toolchain holds preparation with a clear reason", async () => {
  const f = preparationFixture(crate);
  const empty = join(f.directory, "no-cargo");
  mkdirSync(empty);
  process.env["PATH"] = empty;
  const held = prepareRelease(f.config, f.input, f.record);
  await expect(held).rejects.toBeInstanceOf(DeploymentHeld);
  await expect(held).rejects.toThrow("no cargo was found; install stable Rust with rustup");
  expect(existsSync(join(f.record.releasePath, "target"))).toBe(false);
  expect(f.record.preparedAt).toBeUndefined();
  expect(lstatSync(f.config.liveSource, { throwIfNoEntry: false })).toBeUndefined();
});

it("a failed native build holds preparation and names the command to rerun", async () => {
  const f = preparationFixture(crate);
  fakeCargo(f.directory, true);
  await expect(prepareRelease(f.config, f.input, f.record)).rejects.toThrow(
    "building the release's native Cataly binary failed",
  );
  expect(existsSync(treeNativeBinaries(f.record.releasePath)[1])).toBe(false);
});

/** A prepared crate tree, as `prepareRelease` leaves it before the native step. */
const crateTree = (release: string): void => {
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "Cargo.toml"), crate["Cargo.toml"]);
};

it("a release that bundles its binary uses it and is not rebuilt", async () => {
  const f = preparationFixture();
  const [bundled, built] = treeNativeBinaries(f.record.releasePath);
  crateTree(f.record.releasePath);
  mkdirSync(join(bundled, ".."), { recursive: true });
  writeFileSync(bundled, "#!/bin/sh\n", { mode: 0o755 });
  const log = fakeCargo(f.directory);
  await prepareNativeHost(f.config, f.record);
  expect(existsSync(log)).toBe(false);
  expect(existsSync(built)).toBe(false);
});

it("an unattended run without cargo on PATH uses rustup's default cargo for the operator", async () => {
  const f = preparationFixture();
  crateTree(f.record.releasePath);
  const log = fakeCargo(f.directory);
  const rustup = join(f.config.home, ".cargo", "bin");
  mkdirSync(rustup, { recursive: true });
  writeFileSync(join(rustup, "cargo"), readFileSync(join(f.directory, "fake-cargo-bin", "cargo")), { mode: 0o755 });
  process.env["PATH"] = join(f.directory, "no-cargo-here");
  await prepareNativeHost(f.config, f.record);
  expect(readFileSync(log, "utf8")).toContain("arg=--locked");
  expect(lstatSync(treeNativeBinaries(f.record.releasePath)[1]).isFile()).toBe(true);
});
