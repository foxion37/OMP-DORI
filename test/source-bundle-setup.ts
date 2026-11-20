import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nativeDirectory, nativeLauncher, type NativeReceipt } from "../src/release/native.ts";
import { type ProcessCwds, processCwds } from "../src/release/process-cwd.ts";
import { type ProcessFiles, processFiles } from "../src/release/process-files.ts";
import { readSourceBundle, type SourceBundle } from "../src/release/source-bundle.ts";
import { digest } from "../src/update/source.ts";

// Native fixtures bind a tracked viewer manifest to synthetic admission bytes, never an application viewer.
const NATIVE_VIEWER_FIXTURE = "isolated viewer admission bytes, not an application viewer\n";

export function fixtureGit(cwd: string, ...argv: string[]): string {
  const windows = process.platform === "win32";
  const devNull = windows ? "NUL" : "/dev/null";
  // No automatic gc or maintenance: a detached one would outlive the call with its working directory in the fixture.
  const git = ["git", "-c", `core.hooksPath=${devNull}`, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...argv];
  const result = Bun.spawnSync(
    // umask keeps the fixture private on POSIX; the Windows shell has neither command.
    windows ? git : ["/bin/sh", "-c", 'umask 077; exec "$@"', "dori-source-fixture", ...git],
    {
      cwd,
      env: {
        PATH: process.env["PATH"],
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Source bundle fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "Source bundle fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** Real Git patches, index trees and file bytes; no network or native binary is needed for identity regressions. */
export function overlayFixture(source: string, checkout: string, native = false, selected = "reviewed-overlay") {
  mkdirSync(source, { recursive: true, mode: 0o700 });
  mkdirSync(checkout, { recursive: true, mode: 0o700 });
  const put = (path: string, text: string, executable = false) => {
    const full = join(checkout, path);
    mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    writeFileSync(full, text, { mode: executable ? 0o755 : 0o600 });
    if (executable) chmodSync(full, 0o755);
  };
  put(
    ".gitignore",
    ["*.node", "node_modules/", ...(native ? ["packages/coding-agent/export-assets/"] : []), ""].join("\n"),
  );
  // A real upstream shape: Git's own attribute transform rewrites these bytes on checkout.
  put(".gitattributes", "*.cmd text eol=crlf\n");
  put("crates/pi-shell/tests/fixtures/minimizer/cargo/test-pass.cmd", "@echo off\nrem fixture\n");
  put("index.ts", 'export const selected = "base";\n');
  put("presets.ts", "export {};\n");
  if (native) {
    put("packages/coding-agent/scripts/omp", '#!/bin/sh\nprintf "18.20.0\\n"\n', true);
    put("packages/coding-agent/src/cli.ts", 'export const version = "18.20.0";\n');
    put("packages/natives/native/loader-state.js", "export {};\n");
    const hash = digest(NATIVE_VIEWER_FIXTURE);
    put(
      "packages/coding-agent/src/export/html/viewer.generated.json",
      JSON.stringify({
        file: `export-viewer-${hash}.js`,
        integrity: `sha256-${Buffer.from(hash, "hex").toString("base64")}`,
        size: Buffer.byteLength(NATIVE_VIEWER_FIXTURE),
      }),
    );
  }
  fixtureGit(checkout, "init", "--quiet");
  fixtureGit(checkout, "add", ".");
  fixtureGit(checkout, "commit", "--quiet", "-m", "Upstream source fixture");
  const commit = fixtureGit(checkout, "rev-parse", "HEAD");
  put("index.ts", `export const selected = ${JSON.stringify(selected)};\n`);
  const patch = `${fixtureGit(checkout, "diff", "--binary")}\n`;
  fixtureGit(checkout, "add", "index.ts");
  const lock: SourceBundle = {
    version: 1,
    repository: native ? "https://github.com/can1357/oh-my-pi.git" : "https://github.com/dbc-hbin/omp-ulw.git",
    commit,
    patchSha256: digest(patch),
    resultTree: fixtureGit(checkout, "write-tree"),
    files: [{ path: "index.ts", sha256: digest(readFileSync(join(checkout, "index.ts"))), executable: false }],
    ...(native ? { nativeVersion: "18.20.0" as const, launcher: "packages/coding-agent/scripts/omp" } : {}),
  };
  const name = native ? "native-omp" : "omp-ulw.overlay";
  writeFileSync(join(source, `${name}.lock`), `${JSON.stringify(lock)}\n`, { mode: 0o600 });
  writeFileSync(join(source, native ? "native-omp.patch" : "omp-ulw.patch"), patch, { mode: 0o600 });
  if (!native) writeFileSync(join(source, "omp-ulw.lock"), `${commit}\n`, { mode: 0o600 });
  return { source, checkout, lock, patch, commit, put };
}

/** Synthetic addon/viewer bytes exercise admission only; real loading and export are separate installation gates. */
export function nativeCacheFixture(source: string, home: string, upstream: string): NativeReceipt {
  const directory = nativeDirectory(source, home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bundle = readSourceBundle(source, true);
  const checkout = join(directory, "source");
  fixtureGit(directory, "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", upstream, checkout);
  fixtureGit(checkout, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", bundle.lock.commit);
  fixtureGit(checkout, "apply", "--index", "--", bundle.patch);
  for (const path of ["bin", "launch-cwd", "natives"]) mkdirSync(join(directory, path), { mode: 0o700 });
  mkdirSync(join(source, "native-addon"), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, "native-addon/bun.lock"), "isolated identity fixture lock\n", { mode: 0o600 });
  writeFileSync(join(source, "native-addon/package.json"), "{}\n", { mode: 0o600 });
  const bun = realpathSync(process.execPath);
  const launcher = nativeLauncher(source, home, directory, bun);
  writeFileSync(join(directory, "bin/omp"), launcher, { mode: 0o700 });
  symlinkSync(bun, join(directory, "bin/bun"));
  const addon = join(directory, "source/packages/natives/native/pi_natives.fixture.node");
  writeFileSync(addon, "isolated receipt bytes, not a loadable native addon\n", { mode: 0o600 });
  const assets = join(checkout, "packages/coding-agent/export-assets");
  const manifest = JSON.parse(
    readFileSync(join(checkout, "packages/coding-agent/src/export/html/viewer.generated.json"), "utf8"),
  );
  mkdirSync(assets, { mode: 0o700 });
  writeFileSync(join(assets, manifest.file), NATIVE_VIEWER_FIXTURE, { mode: 0o600 });
  const receipt: NativeReceipt = {
    version: 1,
    source,
    identity: readSourceBundle(source, true).identity,
    directory,
    omp: join(directory, "bin/omp"),
    ompHash: digest(launcher),
    entry: join(directory, "source/packages/coding-agent/src/cli.ts"),
    bun,
    bunHash: digest(readFileSync(bun)),
    addonLockHash: digest(readFileSync(join(source, "native-addon/bun.lock"))),
    addon,
    addonHash: digest(readFileSync(addon)),
  };
  writeFileSync(join(directory, "native-config.json"), JSON.stringify({ update: { auto: false } }), { mode: 0o600 });
  writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
  return receipt;
}

/**
 * The host's process working directories without the host's own unreadable processes (a session manager or agent that
 * is not dumpable), which no fixture controls; a fixture's own unreadable process is tested against the real reader.
 */
export const ownProcessCwds = (pids: readonly string[]): ProcessCwds | null => {
  const read = processCwds(pids);
  return read && { cwds: read.cwds, unreadable: [] };
};

/**
 * The host's process files without its unreadable processes, which no fixture controls (see `ownProcessCwds`). Off
 * Linux it reads nothing: the tests that hold files run on Linux only, and each read there is a full lsof run that
 * slows every other test on the runner; `processFiles("darwin")` is tested on its own.
 * An explicit list opts into the same Linux reader for only those fixture-controlled PIDs. Include this worker and
 * every locally spawned live holder; leave it unset for discovery tests.
 */
export const ownProcessFiles = (pids?: readonly string[]): ProcessFiles | null => {
  if (process.platform !== "linux") return { files: new Map(), unread: [] };
  const read = processFiles("linux", pids);
  return read && { files: read.files, unread: [] };
};
