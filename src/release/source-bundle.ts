import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { command } from "../update/deployment-process.ts";
import { digest } from "../update/source.ts";
import type { SourceEntry } from "../update/types.ts";
import { owned, readJson, realDirectory, regularFile } from "./files.ts";
import { assertNativeExport } from "./native-export.ts";

export class SourceBundleError extends Error {}

export type SourceBundle = {
  readonly version: 1;
  readonly repository: string;
  readonly commit: string;
  readonly patchSha256: string;
  readonly resultTree: string;
  readonly files: readonly SourceEntry[];
  readonly nativeVersion?: "18.20.0";
  readonly launcher?: string;
};
export type BoundBundle = { readonly lock: SourceBundle; readonly patch: string; readonly identity: string };
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const safe = (path: unknown): path is string =>
  typeof path === "string" &&
  ![...path].some((char) => {
    const code = char.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f || char === "\\" || char === ":";
  }) &&
  path.split("/").every((part) => !!part && part !== "." && part !== ".." && part !== ".git");

/** Bind the patch bytes as well as the upstream and postimage identities before touching a checkout. */
export function readSourceBundle(source: string, native = false): BoundBundle {
  const name = native ? "native-omp" : "omp-ulw.overlay";
  const path = join(source, `${name}.lock`);
  const value = readJson(path) as SourceBundle;
  const keys = [
    "version",
    "repository",
    "commit",
    "patchSha256",
    "resultTree",
    "files",
    ...(native ? ["nativeVersion", "launcher"] : []),
  ].sort();
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== keys.join() ||
    value.version !== 1 ||
    !SHA.test(value.commit) ||
    !SHA.test(value.resultTree) ||
    !HASH.test(value.patchSha256) ||
    value.repository !==
      (native ? "https://github.com/can1357/oh-my-pi.git" : "https://github.com/dbc-hbin/omp-ulw.git") ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    (native && (value.nativeVersion !== "18.20.0" || !safe(value.launcher)))
  )
    throw new Error(`Invalid source bundle lock: ${path}`);
  let previous = "";
  for (const file of value.files) {
    if (
      !file ||
      Object.keys(file).sort().join() !== "executable,path,sha256" ||
      !safe(file.path) ||
      file.path <= previous ||
      !HASH.test(file.sha256) ||
      typeof file.executable !== "boolean"
    )
      throw new Error(`Invalid source bundle postimage: ${path}`);
    previous = file.path;
  }
  const patch = join(source, native ? "native-omp.patch" : "omp-ulw.patch");
  if (!regularFile(patch) || digest(readFileSync(patch)) !== value.patchSha256)
    throw new Error(`Source bundle patch digest differs: ${patch}`);
  return { lock: value, patch, identity: digest(Buffer.concat([readFileSync(path), readFileSync(patch)])) };
}

const args = (argv: readonly string[]): string[] => [
  "git",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "gc.auto=0",
  ...argv,
];
export const bundleEnv = (home: string, bun = process.execPath): Record<string, string> => ({
  HOME: home,
  PATH: `${dirname(bun)}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  BUN_INSTALL_CACHE_DIR: join(home, ".cache/omp-dori/bun"),
  DORI_TELEMETRY: "0",
  DO_NOT_TRACK: "1",
});
export const bundleGit = (argv: readonly string[], cwd: string, home: string): Promise<string> =>
  command(["/bin/sh", "-c", 'umask 077; exec "$@"', "dori-source-git", ...args(argv)], cwd, bundleEnv(home), 300_000);

/**
 * Synchronous admission also runs at launch; a version or a launcher hash alone is never a receipt.
 * Every tracked regular file's content is compared to its index blob through one batched attribute-aware
 * hash, so a legitimate checkout transform is admitted and any real content change is still rejected.
 */
export function assertSourceBundle(checkout: string, bundle: BoundBundle, home: string): void {
  realDirectory(checkout);
  owned(checkout);
  realDirectory(join(checkout, ".git"));
  const git = (argv: readonly string[], input?: string): string => {
    const proc = Bun.spawnSync(args(argv), {
      cwd: checkout,
      env: bundleEnv(home),
      stdin: input === undefined ? "ignore" : Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error("Bound source checkout changed or its Git identity is unavailable");
    return proc.stdout.toString().trim();
  };
  if (
    git(["rev-parse", "HEAD"]) !== bundle.lock.commit ||
    git(["write-tree"]) !== bundle.lock.resultTree ||
    git(["diff-files", "--ignore-submodules=none", "--name-only"]) !== ""
  )
    throw new Error("Bound source checkout differs from its upstream, patch or resulting tree");
  const nativeExport = bundle.lock.nativeVersion && assertNativeExport(checkout, false);
  for (const path of git(["ls-files", "--others", "--directory", "-z"]).split("\0").filter(Boolean)) {
    if (
      bundle.lock.nativeVersion &&
      (path.split("/").includes("node_modules") ||
        /^packages\/natives\/native\/pi_natives\.[a-z0-9-]+\.node$/.test(path) ||
        (nativeExport && path === "packages/coding-agent/export-assets/"))
    )
      continue;
    throw new Error(`Bound source has an unexpected untracked path: ${path}`);
  }
  const regular: { readonly path: string; readonly oid: string }[] = [];
  for (const entry of git(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}) 0\t(.+)$/.exec(entry);
    if (!match || !safe(match[3]) || !match[2]) throw new Error("Bound source index contains an invalid path or stage");
    if (match[1] === "160000") continue;
    const stat = lstatSync(join(checkout, match[3]));
    if (match[1] === "120000") {
      // A symlink's index object is its link text, which no checkout attribute rewrites.
      if (!stat.isSymbolicLink()) throw new Error(`Bound source tracked type or mode differs: ${match[3]}`);
      const target = Buffer.from(readlinkSync(join(checkout, match[3])));
      const oid = createHash("sha1").update(`blob ${target.length}\0`).update(target).digest("hex");
      if (oid !== match[2]) throw new Error(`Bound source symlink target differs: ${match[3]}`);
      continue;
    }
    if (!stat.isFile() || ((stat.mode & 0o111) !== 0) !== (match[1] === "100755"))
      throw new Error(`Bound source tracked type or mode differs: ${match[3]}`);
    regular.push({ path: match[3], oid: match[2] });
  }
  // One batched hash over the real paths, with filters enabled, applies each file's authenticated
  // checkout attributes: `text eol=crlf` returns to its index blob, while mutated bytes never do.
  const observed =
    regular.length === 0
      ? []
      : git(["hash-object", "--stdin-paths"], `${regular.map((file) => file.path).join("\n")}\n`)
          .split("\n")
          .filter(Boolean);
  if (observed.length !== regular.length || regular.some((file, at) => observed[at] !== file.oid))
    throw new Error("Bound source tracked content differs from its index after checkout attributes");
  for (const file of bundle.lock.files) {
    const path = join(checkout, file.path);
    if (
      !regularFile(path) ||
      digest(readFileSync(path)) !== file.sha256 ||
      ((lstatSync(path).mode & 0o111) !== 0) !== file.executable
    )
      throw new Error(`Bound source postimage differs: ${file.path}`);
  }
}
