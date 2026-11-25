import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseManifest } from "../src/release/types.ts";
import { releaseVersion } from "../src/release/version.ts";
import { sameManifest, sourceManifest } from "../src/update/source.ts";
import type { SourceManifest } from "../src/update/types.ts";
import { git } from "./release-process.ts";
import { committedSource } from "./release-source.ts";

export type NativeHost = { readonly platform: string; readonly arch: string; readonly target: string };

/** Every public release bundles the native Cataly binary for each supported headless host. */
export const nativeHosts = [
  { platform: "linux", arch: "x64", target: "x86_64-unknown-linux-gnu" },
  { platform: "darwin", arch: "arm64", target: "aarch64-apple-darwin" },
] as const satisfies readonly NativeHost[];

export const nativeHostName = (host: NativeHost): string => `${host.platform}-${host.arch}`;
export const nativeReleasePath = (host: NativeHost): string => `native-bin/${nativeHostName(host)}/cataly`;

export function currentNativeHost(): NativeHost | undefined {
  return nativeHosts.find((host) => host.platform === process.platform && host.arch === process.arch);
}

/** Opens one regular file without following a final link; its parent must be a real directory. */
export function readRegularFile(directory: string, name: string): Buffer {
  if (!lstatSync(directory).isDirectory()) throw new Error(`Release input must be a real directory: ${directory}`);
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Release asset must be a regular file: ${name}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Linux x64 ships a little-endian ELF64 x86-64 executable; Darwin arm64 ships a 64-bit arm64 Mach-O executable. */
export function assertNativeExecutable(host: NativeHost, bytes: Buffer): void {
  const valid =
    bytes.length >= 64 &&
    (host.platform === "linux"
      ? bytes.readUInt32BE(0) === 0x7f454c46 &&
        bytes[4] === 2 &&
        bytes[5] === 1 &&
        [2, 3].includes(bytes.readUInt16LE(16)) &&
        bytes.readUInt16LE(18) === 62
      : bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c && bytes.readUInt32LE(12) === 2);
  if (!valid) throw new Error(`Native Cataly for ${nativeHostName(host)} is not an executable for that host`);
}

/**
 * Build the running host's binary from an extracted committed tree without user Cargo or compiler settings. The build
 * must leave that tree exactly as committed.
 */
export async function buildNativeRelease(
  source: string,
  temporary: string,
  host: NativeHost,
  committed: SourceManifest,
): Promise<Buffer> {
  if (currentNativeHost() !== host)
    throw new Error(`Native Cataly for ${nativeHostName(host)} builds only on that host`);
  const cargo = Bun.which("cargo");
  if (!cargo) throw new Error(`Cargo is required to package the ${nativeHostName(host)} Cataly release`);
  const targetDir = join(temporary, "cargo-target");
  const child = Bun.spawn(
    [
      cargo,
      "build",
      "--manifest-path",
      join(source, "Cargo.toml"),
      "--locked",
      "--release",
      "--bin",
      "cataly",
      "--target",
      host.target,
      "--target-dir",
      targetDir,
    ],
    {
      // Cargo discovers .cargo/config relative to its invocation directory, not --manifest-path.
      cwd: "/",
      // Do not load user Cargo config, RUSTFLAGS, compiler wrappers, linker or deployment-target settings.
      env: {
        PATH: process.env["PATH"],
        RUSTUP_HOME: process.env["RUSTUP_HOME"] ?? join(homedir(), ".rustup"),
        RUSTUP_TOOLCHAIN: process.env["RUSTUP_TOOLCHAIN"],
        CARGO_HOME: join(temporary, "cargo-home"),
        CARGO_ENCODED_RUSTFLAGS: `--remap-path-prefix=${temporary}=/cataly`,
        CARGO_INCREMENTAL: "0",
        SOURCE_DATE_EPOCH: "0",
        LC_ALL: "C",
        TZ: "UTC",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: 600_000,
      killSignal: "SIGKILL",
    },
  );
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Cargo release build failed (${code}): ${stderr.trim()}`);
  const afterBuild = sourceManifest(source);
  if (!sameManifest(committed, afterBuild) || afterBuild.excluded.length !== 0)
    throw new Error("Committed source changed during the Cargo release build");
  const binary = readRegularFile(join(targetDir, host.target, "release"), "cataly");
  assertNativeExecutable(host, binary);
  return binary;
}

/**
 * Binaries the running host cannot build arrive as `<dir>/<platform>-<arch>/cataly`, produced by `release.ts native`
 * on their own host. Nothing else may be in the directory, and the running host's own binary is always rebuilt.
 */
export function readNativeInputs(
  directory: string | undefined,
  local: NativeHost | undefined,
): Map<NativeHost, Buffer> {
  const inputs = new Map<NativeHost, Buffer>();
  if (directory === undefined) return inputs;
  if (!lstatSync(directory).isDirectory()) throw new Error(`Native input must be a real directory: ${directory}`);
  for (const entry of readdirSync(directory).sort()) {
    const host = nativeHosts.find((candidate) => nativeHostName(candidate) === entry);
    if (!host || host === local) throw new Error(`Unexpected native input: ${entry}`);
    const hostDirectory = join(directory, entry);
    if (!lstatSync(hostDirectory).isDirectory() || readdirSync(hostDirectory).join() !== "cataly")
      throw new Error(`Native input ${entry} must contain only cataly`);
    const binary = readRegularFile(hostDirectory, "cataly");
    assertNativeExecutable(host, binary);
    inputs.set(host, binary);
  }
  return inputs;
}

/** Public releases bundle every supported host's executable binary; local smokes may bundle only their own. */
export function assertNativeHosts(manifest: ReleaseManifest): void {
  for (const host of nativeHosts) {
    const entry = manifest.source.files.find((file) => file.path === nativeReleasePath(host));
    if (!entry?.executable) throw new Error(`Release lacks the executable native Cataly for ${nativeHostName(host)}`);
  }
}

/** One committed-HEAD build in its own release-shaped scratch tree, exactly as `release-build.ts` lays it out. */
async function buildCommitted(root: string, tree: string, host: NativeHost): Promise<Buffer> {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "cataly-release-")));
  try {
    const source = join(temporary, `cataly-${releaseVersion}`);
    return await buildNativeRelease(source, temporary, host, await committedSource(root, tree, source));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Two independent scratch builds must agree byte for byte before a binary leaves its producing host. */
export async function buildReproducibleNative(root: string): Promise<{ host: NativeHost; binary: Buffer }> {
  const host = currentNativeHost();
  if (!host) throw new Error(`No native Cataly release target for ${process.platform}-${process.arch}`);
  const commit = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
  const tree = (await git(root, ["rev-parse", "--verify", `${commit}^{tree}`])).toString().trim();
  const first = await buildCommitted(root, tree, host);
  const second = await buildCommitted(root, tree, host);
  if (!first.equals(second)) throw new Error(`Native Cataly for ${nativeHostName(host)} is not reproducible`);
  return { host, binary: first };
}
