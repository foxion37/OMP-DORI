import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, withUlwRemote } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and links checkouts with POSIX symlinks.
const posix = test.skipIf(process.platform === "win32");

posix("the default source dependency uses the bound upstream and applies its reviewed overlay", () => {
  const { home, first, commit, config, ulwHead, install } = withUlwRemote();
  commit("u2");
  expect(install().code).toBe(0);
  expect(ulwHead()).toBe(first);
  const selected = join(home, ".dori/omp-ulw/index.ts");
  expect(readFileSync(selected, "utf8")).toContain("export const reviewedOverlay = true");
  expect(readlinkSync(join(home, "extensions/omp-ulw"))).toBe(join(home, ".dori/omp-ulw"));
  expect(config().ompUlwPath).toBe("");
});

posix("reinstall preserves the bound overlay instead of following a newer unreviewed main", () => {
  const { home, first, commit, ulwHead, install } = withUlwRemote();
  expect(install().code).toBe(0);
  commit("u2");
  expect(install().code).toBe(0);
  expect(ulwHead()).toBe(first);
  expect(readFileSync(join(home, ".dori/omp-ulw/index.ts"), "utf8")).toContain("reviewedOverlay");
});

posix("OMP_ULW_REF=lock keeps the revision in omp-ulw.lock", () => {
  // Given an omp-ulw remote whose main is past the lock.
  const { first, commit, ulwHead, install } = withUlwRemote();
  commit("u2");
  // When the source installer runs with OMP_ULW_REF=lock; then omp-ulw is at the locked commit.
  expect(install({ OMP_ULW_REF: "lock" }).code).toBe(0);
  expect(ulwHead()).toBe(first);
});

posix("an external native override does not silently switch the locked default to main", () => {
  const { first, commit, ulwHead, install } = withUlwRemote();
  const latest = commit("u2");
  expect(install({ INSTALL_TEST_OMP_VERSION: "18.18.9" }).code).toBe(0);
  expect(ulwHead()).toBe(first);
  expect(install({ INSTALL_TEST_OMP_VERSION: "18.18.9", OMP_ULW_REF: "main" }).code).toBe(0);
  expect(ulwHead()).toBe(latest);
});

const ulwCheckout = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), "export default () => {};\n");
  writeFileSync(join(dir, "presets.ts"), "export {};\n");
};

posix("a standalone omp-ulw extension is reused: no second checkout and no second import", () => {
  // Given omp-ulw installed as an OMP extension by hand, at a revision from before it had a package.json.
  const { home, config, install } = withUlwRemote();
  const standalone = join(home, "extensions/omp-ulw");
  ulwCheckout(standalone);
  // When the source installer runs.
  const r = install();
  // Then omp-dori clones nothing and its config leaves omp-ulw to that extension.
  expect(r.code).toBe(0);
  expect(existsSync(join(home, ".dori/omp-ulw"))).toBe(false);
  expect(config().ompUlwPath).toBe("");
});

posix("a config that points ompUlwPath at its own checkout keeps that checkout, now as the extension", () => {
  // Given a config whose ompUlwPath is a checkout of the owner's own.
  const { home, config, install } = withUlwRemote();
  const own = join(home, "my-ulw");
  ulwCheckout(own);
  mkdirSync(join(home, ".dori"));
  writeFileSync(join(home, ".dori/.omp-dori"), "primary\n");
  writeFileSync(join(home, ".dori/config.json"), JSON.stringify({ ompUlwPath: join(own, "index.ts") }));
  // When the source installer runs; then nothing is cloned, that checkout is the extension, and the import path is emptied.
  const r = install();
  expect(r.code).toBe(0);
  expect(existsSync(join(home, ".dori/omp-ulw"))).toBe(false);
  expect(readlinkSync(join(home, "extensions/omp-ulw"))).toBe(own);
  expect(config().ompUlwPath).toBe("");
  expect(install().code).toBe(0);
  expect(readlinkSync(join(home, "extensions/omp-ulw"))).toBe(own);
  expect(existsSync(join(home, ".dori/omp-ulw"))).toBe(false);
});

posix.each(["lock", "main"])("a standalone extension replaces only the installer's owned %s link", (ref) => {
  // Given an install that linked its omp-ulw checkout, and a standalone omp-ulw added later.
  const { home, install } = withUlwRemote();
  expect(install({ OMP_ULW_REF: ref }).code).toBe(0);
  expect(readlinkSync(join(home, "extensions/omp-ulw"))).toBe(
    join(home, ref === "lock" ? ".dori/omp-ulw" : ".dori/omp-ulw-custom"),
  );
  ulwCheckout(join(home, "extensions/omp-ulw-main"));
  // When the source installer runs again; then the standalone is used and the earlier link is gone, so omp-ulw loads once.
  const r = install();
  expect(r.code).toBe(0);
  expect(existsSync(join(home, "extensions/omp-ulw"))).toBe(false);
});

posix.each(["branch", "tag", "commit"])("OMP_ULW_REF selects a custom %s from OMP_ULW_REPO", (kind) => {
  const { remote, first, commit, ulwHead, install } = withUlwRemote();
  git(remote, "branch", "selected-branch", first);
  git(remote, "tag", "selected-tag", first);
  commit("newer-main");
  const ref = kind === "branch" ? "selected-branch" : kind === "tag" ? "selected-tag" : first;
  expect(install({ OMP_ULW_REF: ref }).code).toBe(0);
  expect(ulwHead()).toBe(first);
});

posix("an explicit main profile can select a new fork for its separate custom checkout", () => {
  const { root, remote, ulwHead, install } = withUlwRemote();
  expect(install({ OMP_ULW_REF: "main" }).code).toBe(0);
  const fork = join(root, "ulw-fork");
  git(root, "clone", "-q", remote, fork);
  writeFileSync(join(fork, "fork.txt"), "fork revision\n");
  git(fork, "add", ".");
  git(fork, "commit", "-qm", "fork");
  const selected = git(fork, "rev-parse", "HEAD");
  expect(install({ OMP_ULW_REPO: fork, OMP_ULW_REF: "main" }).code).toBe(0);
  expect(ulwHead()).toBe(selected);
});

posix("an explicit checkout already registered as a standalone extension gets no second link", () => {
  const { home, config, install } = withUlwRemote();
  const standalone = join(home, "extensions/owner-ulw");
  ulwCheckout(standalone);
  expect(install({ OMP_ULW_SRC: standalone }).code).toBe(0);
  expect(existsSync(join(home, "extensions/omp-ulw"))).toBe(false);
  expect(existsSync(join(home, ".dori/omp-ulw"))).toBe(false);
  expect(config().ompUlwPath).toBe("");
});

posix("an unmarked default-looking ULW link is retained when another standalone extension exists", () => {
  const { root, home, src, upstreamCommit, install } = withUlwRemote();
  const dependency = join(home, ".dori/omp-ulw");
  ulwCheckout(dependency);
  mkdirSync(join(home, "extensions"));
  symlinkSync(dependency, join(home, "extensions/omp-ulw"));
  ulwCheckout(join(home, "extensions/owner-ulw"));
  const before = git(src, "rev-parse", "HEAD");
  upstreamCommit("pending\n");
  expect(install().code).toBe(1);
  expect(readlinkSync(join(home, "extensions/omp-ulw"))).toBe(dependency);
  expect(git(src, "rev-parse", "HEAD")).toBe(before);
  expect(existsSync(join(root, "bun.log"))).toBe(false);
});

posix("a different owner standalone holds an explicit primary checkout before source or config changes", () => {
  const { root, home, src, ulw, upstreamCommit, install } = withUlwRemote();
  const standalone = join(home, "extensions/omp-ulw");
  ulwCheckout(standalone);
  const before = git(src, "rev-parse", "HEAD");
  upstreamCommit("pending\n");
  expect(install({ OMP_ULW_SRC: ulw }).code).toBe(1);
  expect(readFileSync(join(standalone, "presets.ts"), "utf8")).toBe("export {};\n");
  expect(git(src, "rev-parse", "HEAD")).toBe(before);
  expect(existsSync(join(home, ".dori/config.json"))).toBe(false);
  expect(existsSync(join(root, "bun.log"))).toBe(false);
});

posix("a side custom checkout survives clearing the import path and later reinstalls", () => {
  const { home, install } = withUlwRemote();
  const side = join(home, ".omp-dori");
  const own = join(home, "my-ulw");
  ulwCheckout(own);
  mkdirSync(side);
  const config = join(side, "config.json");
  writeFileSync(config, JSON.stringify({ ompUlwPath: join(own, "index.ts"), defaultModel: "fixture/preserved" }));
  expect(install({ DORI_INSTALL_MODE: "side" }).code).toBe(0);
  expect(readlinkSync(join(side, ".omp-dori-ulw"))).toBe(own);
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
    ompUlwPath: "",
    defaultModel: "fixture/preserved",
    agentCommand: [join(side, "bin/omp"), "--dori-role", "lane", "--model", "{model}", "{prompt}"],
  });
  expect(install().code).toBe(0);
  expect(readlinkSync(join(side, ".omp-dori-ulw"))).toBe(own);
  expect(existsSync(join(side, "omp-ulw"))).toBe(false);
  expect(existsSync(join(home, "extensions"))).toBe(false);
});

posix("a modified bound source dependency holds reinstall and retains the owner's edit", () => {
  const { home, env, install } = withUlwRemote();
  expect(install().code).toBe(0);
  const entry = join(home, ".dori/omp-ulw/index.ts");
  writeFileSync(entry, "owner edit\n");
  expect(install().code).not.toBe(0);
  expect(readFileSync(entry, "utf8")).toBe("owner edit\n");
  const launch = Bun.spawnSync([join(home, ".dori/bin/omp"), "--version"], { env: env() });
  expect(launch.exitCode).not.toBe(0);
});
