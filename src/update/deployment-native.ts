import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { firstNativeBinary, treeNativeBinaries } from "../native-binary.ts";
import { command, DeploymentHeld, DeploymentRetryable } from "./deployment-process.ts";
import type { DeploymentConfig, DeploymentRecord } from "./deployment-types.ts";

const BUILD_MS = 900_000;

/**
 * The prepared release's own native host, so `harness up` and every later CLI run from that tree find a same-commit
 * binary: a release-bundled `native-bin/<platform>-<arch>/cataly` is used as is; otherwise the tree is built into its
 * manifest-omitted `target/`. Runs before any stop, so a missing toolchain or failed build holds the old harness.
 */
export async function prepareNativeHost(
  config: DeploymentConfig,
  record: DeploymentRecord,
  signal?: AbortSignal,
): Promise<void> {
  const tree = record.releasePath;
  // Trees from before the Rust crate host their lanes on Bun.
  if (!lstatSync(join(tree, "Cargo.toml"), { throwIfNoEntry: false })) return;
  const [bundled, built] = treeNativeBinaries(tree);
  if (firstNativeBinary([bundled])) return;
  // Unattended runs may lack the login PATH; rustup's default location is the fallback.
  const cargo =
    Bun.which("cargo", { PATH: process.env["PATH"] ?? "" }) ??
    firstNativeBinary([join(config.home, ".cargo", "bin", "cargo")]);
  if (!cargo)
    throw new DeploymentHeld(
      "the release must build its native Cataly binary and no cargo was found; install stable Rust with rustup for " +
        "this user, then retry the deployment",
    );
  const home = join(record.directory, "prepare-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // No user Cargo config, compiler wrappers or flags; only the toolchain selection crosses.
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${dirname(cargo)}:/usr/bin:/bin`,
    RUSTUP_HOME: process.env["RUSTUP_HOME"] ?? join(config.home, ".rustup"),
    ...(process.env["RUSTUP_TOOLCHAIN"] ? { RUSTUP_TOOLCHAIN: process.env["RUSTUP_TOOLCHAIN"] } : {}),
    CARGO_HOME: join(record.directory, "cargo-home"),
    CARGO_INCREMENTAL: "0",
    LC_ALL: "C",
  };
  const build = ["build", "--manifest-path", join(tree, "Cargo.toml"), "--locked", "--release", "--bin", "cataly"];
  const argv = [cargo, ...build, "--target-dir", dirname(dirname(built))];
  try {
    // Cargo discovers .cargo/config relative to its working directory, not --manifest-path.
    await command(
      ["/bin/sh", "-c", 'umask 077; exec "$@"', "cataly-managed-cargo", ...argv],
      "/",
      env,
      BUILD_MS,
      signal,
    );
  } catch (error) {
    if (!(error instanceof DeploymentRetryable)) throw error;
    throw new DeploymentHeld(
      `building the release's native Cataly binary failed (${error.message}); run \`cargo build --locked --release ` +
        `--bin cataly\` in ${tree} to see why, then retry the deployment`,
    );
  }
  if (!firstNativeBinary([built])) throw new DeploymentHeld("the release's native Cataly build produced no binary");
}
