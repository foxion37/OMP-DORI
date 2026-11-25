import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rootStoreHome } from "./store-lanes.ts";

/** The one override: an absolute path wins for every native use; `off` (or empty) disables only Discord features. */
export const NATIVE_BINARY_ENV = "CATALY_DISCORD_NATIVE_BIN";

const disabled = (value: string | undefined): boolean => value === "" || value === "off";

/**
 * A code tree's own binaries, same commit by construction: the release-bundled `native-bin/<platform>-<arch>/cataly`,
 * then `target/managed/release/cataly`, which only managed source deployment writes (`cargo build --locked --release
 * --bin cataly --target-dir <tree>/target/managed`). A developer's own `target/release` build is never picked up.
 */
export const treeNativeBinaries = (root: string): readonly [bundled: string, built: string] => [
  join(root, "native-bin", `${process.platform}-${process.arch}`, "cataly"),
  join(root, "target", "managed", "release", "cataly"),
];

/** The first executable regular file; a present non-file or non-executable candidate is an error, never skipped. */
export function firstNativeBinary(paths: readonly string[]): string | undefined {
  for (const path of paths) {
    try {
      if (!lstatSync(path).isFile()) throw new Error(`Native Cataly binary is not a regular file: ${path}`);
      accessSync(path, constants.X_OK);
      return path;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return undefined;
}

/**
 * The Cataly native binary: an absolute {@link NATIVE_BINARY_ENV}, else the {@link treeNativeBinaries} of the code tree
 * running this module (`root`), else the installed `$CATALY_HOME/bin/cataly-native` (`CATALY_HOME` defaults to
 * `~/.cataly`). Never searched for in the caller's cwd or PATH. `off` skips the override and searches the rest.
 */
export function nativeBinary(root = fileURLToPath(new URL("..", import.meta.url))): string | undefined {
  const configured = process.env[NATIVE_BINARY_ENV];
  if (configured !== undefined && !disabled(configured)) {
    if (!isAbsolute(configured)) throw new Error(`${NATIVE_BINARY_ENV} must be absolute or off`);
    return configured;
  }
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  const tree = treeNativeBinaries(root);
  const home = rootStoreHome();
  return firstNativeBinary(isAbsolute(home) ? [...tree, join(home, "bin", "cataly-native")] : tree);
}

/** Discord-native intake, sends, presence and routing; `off` keeps the TypeScript Discord paths. */
export const discordNativeBinary = (): string | undefined =>
  disabled(process.env[NATIVE_BINARY_ENV]) ? undefined : nativeBinary();
