// One-way bridge from previous installations (see cli.ts). Only the installers run it; the product never imports it.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Where earlier installs put things, from the same selectors they read (defaults included). */
export type Places = {
  readonly home: string;
  readonly skills: readonly string[];
  readonly extensions: readonly string[];
  readonly bins: readonly string[];
  readonly bunGlobal: string;
  readonly caches: string;
};

const absolute = (value: string | undefined): string | undefined =>
  value && isAbsolute(value) ? resolve(value) : undefined;
const unique = (values: readonly (string | undefined)[]): string[] => [
  ...new Set(values.filter((v): v is string => !!v)),
];

export function places(env: Readonly<Record<string, string | undefined>>): Places {
  const home = resolve(env["HOME"] ?? "/");
  const bun = absolute(env["BUN_INSTALL"]) ?? join(home, ".bun");
  return {
    home,
    skills: unique([absolute(env["SKILLS_DIR"]), join(home, ".agents/skills")]),
    extensions: unique([absolute(env["OMP_EXTENSIONS_DIR"]), join(home, ".omp/agent/extensions")]),
    bins: unique([
      absolute(env["OMP_CATALY_BIN_DIR"]),
      absolute(env["OMP_DORI_BIN_DIR"]),
      join(bun, "bin"),
      join(home, ".bun/bin"),
    ]),
    bunGlobal: join(bun, "install/global/node_modules"),
    caches: join(home, ".cache"),
  };
}

export const entry = (path: string) => lstatSync(path, { throwIfNoEntry: false });
const mine = (uid: number) => process.getuid === undefined || uid === process.getuid();
/** A real directory of this user, never reached through a link. */
export const ownDirectory = (path: string): boolean => {
  const stat = entry(path);
  return stat?.isDirectory() === true && mine(stat.uid);
};
export const ownLink = (path: string): boolean => {
  const stat = entry(path);
  return stat?.isSymbolicLink() === true && mine(stat.uid);
};
export const ownFile = (path: string): boolean => {
  const stat = entry(path);
  return stat?.isFile() === true && mine(stat.uid);
};
/** A regular file at `path`, following links (an install pointer into a release counts). */
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
export const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * A Cataly or omp-dori source tree, checkout or release: its skill CLI and its source-bundle lock. The original Dori
 * (sisyphuslabs/dori-superagent) has the same skill CLI but no lock, so its trees never match.
 */
export const ourTree = (root: string): boolean =>
  ["cataly-mode", "dori-mode"].some((skill) => isFile(join(root, "skills", skill, "scripts/src/cli.ts"))) &&
  ["native-omp.lock", "omp-ulw.lock"].some((lock) => isFile(join(root, lock)));

/** Where a link leads: existing ancestors resolved, a missing remainder kept as written. Undefined if unresolvable. */
export function linkTarget(link: string): string | undefined {
  try {
    let ancestor = resolve(dirname(link), readlinkSync(link));
    const rest: string[] = [];
    while (!entry(ancestor)) {
      rest.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
    return join(realpathSync(ancestor), ...rest);
  } catch {
    return undefined;
  }
}

/** The tree root when `path` is `<root><suffix>` inside one of our trees. */
export function treeOf(path: string | undefined, suffix: string): string | undefined {
  if (!path?.endsWith(suffix)) return undefined;
  const root = path.slice(0, path.length - suffix.length);
  return root && ourTree(root) ? root : undefined;
}

export const inside = (path: string, directory: string): boolean => {
  const rel = relative(directory, path);
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
};

/** Remove a tree this user owns, including read-only release directories it froze. */
export function removeTree(path: string): void {
  const unfreeze = (dir: string): void => {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
      const child = join(dir, name);
      if (entry(child)?.isDirectory()) unfreeze(child);
    }
  };
  if (entry(path)?.isDirectory()) unfreeze(path);
  rmSync(path, { recursive: true, force: true });
}

/** Write through a private temporary file and an atomic rename; `check` validates the temporary file first. */
export function writeAtomically(
  path: string,
  bytes: string | Buffer,
  mode: number,
  check?: (temporary: string) => void,
) {
  const temporary = join(dirname(path), `.${basename(path)}.import-${randomUUID()}`);
  writeFileSync(temporary, bytes, { flag: "wx", mode });
  try {
    chmodSync(temporary, mode);
    check?.(temporary);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
