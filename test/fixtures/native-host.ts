import { chmodSync, copyFileSync, linkSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { NATIVE_BINARY_ENV } from "../../src/native-binary.ts";

/**
 * Headless lanes, leads and duty run on the native binary. `bun run test:local` and CI build
 * `target/release/cataly` and pass it through the resolver's override; in-process launches read it directly.
 */
function nativeHostBinary(): string {
  const binary = process.env[NATIVE_BINARY_ENV];
  if (!binary || !isAbsolute(binary))
    throw new Error(
      `${NATIVE_BINARY_ENV} must name the built native host: cargo build --locked --release --bin cataly, then run ` +
        "the suite with bun run test:local",
    );
  return binary;
}

/**
 * Installs the binary where a Cataly home keeps it, for CLIs whose environment is an allowlist without the override.
 * Fixtures whose code tree is this checkout cannot use a tree's own binary: only managed deployment writes that.
 */
export function installNativeHost(catalyHome: string): string {
  const bin = join(catalyHome, "bin");
  const target = join(bin, "cataly-native");
  mkdirSync(bin, { recursive: true });
  try {
    linkSync(nativeHostBinary(), target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
    copyFileSync(nativeHostBinary(), target);
    chmodSync(target, 0o755);
  }
  return target;
}
