import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
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
  readonly nativeVersion: string;
  readonly launcher: string;
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

/** Validate a decoded lock: exact key set, pinned repository, and a strictly ordered postimage. */
export function parseSourceBundleLock(path: string, value: unknown): SourceBundle {
  const keys = ["version", "repository", "commit", "patchSha256", "resultTree", "files", "nativeVersion", "launcher"];
  keys.sort();
  const lock = value as SourceBundle;
  if (
    !lock ||
    typeof lock !== "object" ||
    Object.keys(lock).sort().join() !== keys.join() ||
    lock.version !== 1 ||
    !SHA.test(lock.commit) ||
    !SHA.test(lock.resultTree) ||
    !HASH.test(lock.patchSha256) ||
    lock.repository !== "https://github.com/can1357/oh-my-pi.git" ||
    !Array.isArray(lock.files) ||
    !lock.files.length ||
    typeof lock.nativeVersion !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(lock.nativeVersion) ||
    !safe(lock.launcher)
  )
    throw new Error(`Invalid source bundle lock: ${path}`);
  let previous = "";
  for (const file of lock.files) {
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
  return lock;
}
/** Bind the patch bytes as well as the upstream and postimage identities before touching a checkout. */
export function readSourceBundle(source: string): BoundBundle {
  const path = join(source, "native-omp.lock");
  const value = parseSourceBundleLock(path, readJson(path));
  const patch = join(source, "native-omp.patch");
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
  BUN_INSTALL_CACHE_DIR: join(home, ".cache/omp-cataly/bun"),
  CATALY_TELEMETRY: "0",
  DO_NOT_TRACK: "1",
});
export const bundleGit = (argv: readonly string[], cwd: string, home: string, output?: string): Promise<string> => {
  const script = output === undefined ? 'umask 077; exec "$@"' : 'umask 077; output=$1; shift; exec "$@" > "$output"';
  const shell = ["/bin/sh", "-c", script, "cataly-source-git", ...(output === undefined ? [] : [output])];
  return command([...shell, ...args(argv)], cwd, bundleEnv(home), 300_000);
};

function hashChunks(inputs: readonly string[], checkout: string, home: string): string {
  // One synchronous Bun driver keeps admission synchronous while Git children hash in parallel.
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
const { argv, inputs } = await Bun.stdin.json();
const outputs = await Promise.all(inputs.map(async (input) => {
  const child = Bun.spawn(argv, { stdin: Buffer.from(input), stdout: "pipe", stderr: "inherit" });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) process.exitCode ||= code;
  return output;
}));
if (!process.exitCode) process.stdout.write(outputs.join(""));
`,
    ],
    {
      cwd: checkout,
      env: bundleEnv(home),
      stdin: Buffer.from(JSON.stringify({ argv: args(["hash-object", "--stdin-paths"]), inputs })),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0)
    throw new Error(
      `Bound source Git command failed: git hash-object --stdin-paths exited ${proc.exitCode}: ${proc.stderr.toString().trim().split("\n", 1)[0]}`,
    );
  return proc.stdout.toString().trim();
}

/** Synchronous admission also runs at launch; a version or a launcher hash alone is never a receipt.
 * Every tracked regular file's content is compared to its index blob through batched attribute-aware
 * hashes, so a legitimate checkout transform is admitted and any real content change is still rejected.
 */
export function assertSourceBundle(checkout: string, bundle: BoundBundle, home: string): void {
  realDirectory(checkout);
  owned(checkout);
  realDirectory(join(checkout, ".git"));
  const git = (argv: readonly string[], input?: string, env = bundleEnv(home)): string => {
    const proc = Bun.spawnSync(args(argv), {
      cwd: checkout,
      env,
      stdin: input === undefined ? "ignore" : Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0)
      throw new Error(
        `Bound source Git command failed: git ${argv.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString().trim().split("\n", 1)[0]}`,
      );
    return proc.stdout.toString().trim();
  };
  const head = git(["rev-parse", "HEAD"]);
  // Keep both index locking and newly computed tree objects private to this admission.
  const temporary = mkdtempSync(join(tmpdir(), "cataly-source-index-"));
  let tree: string;
  try {
    const index = join(temporary, "index");
    copyFileSync(join(checkout, ".git/index"), index);
    tree = git(["write-tree"], undefined, {
      ...bundleEnv(home),
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: temporary,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(join(checkout, ".git/objects")),
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (
    head !== bundle.lock.commit ||
    tree !== bundle.lock.resultTree ||
    git(["diff-files", "--ignore-submodules=none", "--name-only"]) !== ""
  )
    throw new Error("Bound source checkout differs from its upstream, patch or resulting tree");
  const nativeExport = assertNativeExport(checkout, false);
  for (const path of git(["ls-files", "--others", "--directory", "-z"]).split("\0").filter(Boolean)) {
    if (
      path.split("/").includes("node_modules") ||
      /^packages\/natives\/native\/pi_natives\.[a-z0-9-]+\.node$/.test(path) ||
      (nativeExport && path === "packages/coding-agent/export-assets/")
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
  // Bound concurrency, retain path order, and avoid driver overhead for small source bundles.
  // Each Git process still applies checkout attributes, including `text eol=crlf`, to the real paths.
  const count = regular.length < 1024 ? 1 : Math.min(4, availableParallelism());
  const size = Math.ceil(regular.length / count);
  const inputs = Array.from(
    { length: count },
    (_, chunk) =>
      `${regular
        .slice(chunk * size, (chunk + 1) * size)
        .map((file) => file.path)
        .join("\n")}\n`,
  );
  const observed =
    regular.length === 0
      ? []
      : (count === 1 ? git(["hash-object", "--stdin-paths"], inputs[0]) : hashChunks(inputs, checkout, home))
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
