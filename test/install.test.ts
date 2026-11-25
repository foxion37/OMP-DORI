import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { git, setup } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and shebang stubs through a ':' PATH.
const posix = test.skipIf(process.platform === "win32");

posix("a second install over a clean checkout pulls upstream", () => {
  // Given an installed checkout and a newer upstream commit.
  const { upstream, src, upstreamCommit, install } = setup();
  upstreamCommit("v2\n");
  // When the source installer runs again; then it succeeds at upstream's head.
  expect(install().code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
});

posix("a local change in the way of the pull stops the install, names the file and says how to go on", () => {
  // Given a checkout with a local edit to a file upstream has since changed.
  const { src, cli, upstreamCommit, install } = setup();
  upstreamCommit("v2\n");
  writeFileSync(join(src, cli), "patched\n");
  // When the source installer runs again.
  const r = install();
  // Then it fails, lists the changed file, and points at the way to install the checkout as it is.
  expect(r.code).toBe(1);
  expect(r.err).toContain(cli);
  expect(r.err).toContain("CATALY_NO_PULL=1");
  expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
});

posix("CATALY_NO_PULL=1 installs a changed checkout as it is, without pulling", () => {
  // Given a checkout with a local edit and a newer upstream commit.
  const { src, home, cli, upstreamCommit, install } = setup();
  const before = git(src, "rev-parse", "HEAD");
  upstreamCommit("v2\n");
  writeFileSync(join(src, cli), "patched\n");
  // When the source installer runs with CATALY_NO_PULL=1.
  const r = install({ CATALY_NO_PULL: "1" });
  // Then the install finishes, and the checkout keeps its commit and its local edit.
  expect(r.code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
  expect(existsSync(join(home, ".cataly/config.json"))).toBe(true);
  expect(existsSync(join(home, ".cataly/bin/cataly-native"))).toBe(false);
});

posix("source install publishes the matching packaged native controller as an owner-only executable", () => {
  const { src, home, install } = setup();
  const hostPackage = join(src, "native-bin", `${process.platform}-${process.arch}`);
  mkdirSync(hostPackage, { recursive: true });
  const contents = "#!/bin/sh\nprintf 'packaged controller\\n'\n";
  writeFileSync(join(hostPackage, "cataly"), contents, { mode: 0o755 });

  const r = install({ CATALY_NO_PULL: "1", CATALY_INSTALL_MODE: "side" });

  expect(r.code).toBe(0);
  const installed = join(home, ".omp-cataly/bin/cataly-native");
  const stat = lstatSync(installed);
  expect(stat.isFile()).toBe(true);
  expect(stat.mode & 0o777).toBe(0o700);
  expect(readFileSync(installed, "utf8")).toBe(contents);
});

test.skipIf(process.platform === "win32" || !Bun.which("cargo") || !Bun.which("rustc"))(
  "source install builds a host-native controller with Cargo when the package is absent",
  () => {
    const { root, src, home, install } = setup();
    mkdirSync(join(src, "native/src"), { recursive: true });
    writeFileSync(
      join(src, "Cargo.toml"),
      '[package]\nname = "cataly"\nversion = "0.1.0"\nedition = "2021"\n\n[[bin]]\nname = "cataly"\npath = "native/src/main.rs"\n',
    );
    writeFileSync(join(src, "Cargo.lock"), 'version = 4\n\n[[package]]\nname = "cataly"\nversion = "0.1.0"\n');
    writeFileSync(join(src, "native/src/main.rs"), 'fn main() { println!("built controller"); }\n');

    const r = install({
      CATALY_NO_PULL: "1",
      CARGO_HOME: join(root, "cargo-home"),
      RUSTUP_HOME: process.env["RUSTUP_HOME"] ?? join(homedir(), ".rustup"),
      CARGO_BUILD_TARGET: "wasm32-unknown-unknown",
      CARGO_NET_OFFLINE: "true",
    });

    expect(r.code).toBe(0);
    const installed = Bun.spawnSync([join(home, ".cataly/bin/cataly-native")], { stdin: "ignore" });
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout.toString()).toBe("built controller\n");
  },
  30_000,
);

posix("a pull blocked by a local commit lists that commit and how to go on", () => {
  // Given a checkout with its own commit on a file upstream has since changed.
  const { src, cli, upstreamCommit, install } = setup();
  upstreamCommit("v2\n");
  writeFileSync(join(src, cli), "local fix\n");
  git(src, "commit", "-qam", "local fix");
  // When the source installer runs again.
  const r = install();
  // Then it fails and names the local commit, which git status alone would not show.
  expect(r.code).toBe(1);
  expect(r.err).toContain("local fix");
  expect(r.err).toContain("CATALY_NO_PULL=1");
});

posix(
  "CATALY_NO_PULL=true and CATALY_NO_PULL=yes skip the pull like CATALY_NO_PULL=1; CATALY_NO_PULL=0 still pulls",
  () => {
    // Given an installed checkout and a newer upstream commit.
    const { upstream, src, upstreamCommit, install } = setup();
    const before = git(src, "rev-parse", "HEAD");
    upstreamCommit("v2\n");
    // When the source installer runs with each truthy spelling; then the checkout stays at its commit.
    for (const value of ["true", "yes"]) {
      expect(install({ CATALY_NO_PULL: value }).code).toBe(0);
      expect(git(src, "rev-parse", "HEAD")).toBe(before);
    }
    // And with 0 it pulls as usual.
    expect(install({ CATALY_NO_PULL: "0" }).code).toBe(0);
    expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
  },
);

posix("a branch with no upstream is not taken for local work: git's reason, no reset suggested", () => {
  // Given a checkout with a local edit whose branch tracks nothing.
  const { src, cli, install } = setup();
  writeFileSync(join(src, cli), "patched\n");
  git(src, "branch", "--unset-upstream");
  // When the source installer runs again.
  const r = install();
  // Then it fails and preserves the local edit.
  expect(r.code).toBe(1);
  expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
});

posix("a failed fetch is not taken for local work: no reset is suggested", () => {
  // Given a checkout with a local edit whose upstream cannot be reached.
  const { root, src, cli, install } = setup();
  writeFileSync(join(src, cli), "patched\n");
  git(src, "remote", "set-url", "origin", join(root, "missing.git"));
  // When the source installer runs again.
  const r = install();
  // Then it fails without changing the checkout.
  expect(r.code).toBe(1);
  expect(r.err).toContain("missing.git");
});

posix("the OMP extension installs without replacing existing owner configuration", () => {
  const { home, src, install } = setup();
  mkdirSync(join(home, ".cataly"));
  writeFileSync(join(home, ".cataly/.omp-cataly"), "primary\n");
  const path = join(home, ".cataly/config.json");
  writeFileSync(
    path,
    JSON.stringify({
      defaultModel: "provider/custom",
      hooks: { threadReply: ["fixture"] },
    }),
  );
  expect(install().code).toBe(0);
  expect(readlinkSync(join(home, "extensions/omp-cataly"))).toBe(join(src, "extension"));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    defaultModel: "provider/custom",
    hooks: { threadReply: ["fixture"] },
    agentCommand: [join(home, ".cataly/bin/omp"), "--cataly-role", "lane", "--model", "{model}", "{prompt}"],
  });
});

posix("an existing non-link extension directory is preserved and stops installation", () => {
  const { home, install } = setup();
  const extension = join(home, "extensions/omp-cataly");
  mkdirSync(extension, { recursive: true });
  writeFileSync(join(extension, "owner.txt"), "keep\n");
  expect(install().code).toBe(1);
  expect(readFileSync(join(extension, "owner.txt"), "utf8")).toBe("keep\n");
});

posix("the full upstream harness Bun requirement is checked before changing the checkout", () => {
  const { upstreamCommit, src, install } = setup();
  const before = git(src, "rev-parse", "HEAD");
  upstreamCommit("v2\n");
  expect(install({ INSTALL_TEST_BUN_VERSION: "1.3.0" }).code).toBe(1);
  expect(git(src, "rev-parse", "HEAD")).toBe(before);
});
