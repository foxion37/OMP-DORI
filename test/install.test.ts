import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, setup } from "./install-setup.ts";

test("a second install over a clean checkout pulls upstream", () => {
  // Given an installed checkout and a newer upstream commit.
  const { upstream, src, upstreamCommit, install } = setup();
  upstreamCommit("v2\n");
  // When the source installer runs again; then it succeeds at upstream's head.
  expect(install().code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
});

test("a local change in the way of the pull stops the install, names the file and says how to go on", () => {
  // Given a checkout with a local edit to a file upstream has since changed.
  const { src, cli, upstreamCommit, install } = setup();
  upstreamCommit("v2\n");
  writeFileSync(join(src, cli), "patched\n");
  // When the source installer runs again.
  const r = install();
  // Then it fails, lists the changed file, and points at the way to install the checkout as it is.
  expect(r.code).toBe(1);
  expect(r.err).toContain(cli);
  expect(r.err).toContain("DORI_NO_PULL=1");
  expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
});

test("DORI_NO_PULL=1 installs a changed checkout as it is, without pulling", () => {
  // Given a checkout with a local edit and a newer upstream commit.
  const { src, home, cli, upstreamCommit, install } = setup();
  const before = git(src, "rev-parse", "HEAD");
  upstreamCommit("v2\n");
  writeFileSync(join(src, cli), "patched\n");
  // When the source installer runs with DORI_NO_PULL=1.
  const r = install({ DORI_NO_PULL: "1" });
  // Then the install finishes, and the checkout keeps its commit and its local edit.
  expect(r.code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(src, cli), "utf8")).toBe("patched\n");
  expect(existsSync(join(home, ".dori/config.json"))).toBe(true);
});

test("a pull blocked by a local commit lists that commit and how to go on", () => {
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
  expect(r.err).toContain("DORI_NO_PULL=1");
});

test("DORI_NO_PULL=true and DORI_NO_PULL=yes skip the pull like DORI_NO_PULL=1; DORI_NO_PULL=0 still pulls", () => {
  // Given an installed checkout and a newer upstream commit.
  const { upstream, src, upstreamCommit, install } = setup();
  const before = git(src, "rev-parse", "HEAD");
  upstreamCommit("v2\n");
  // When the source installer runs with each truthy spelling; then the checkout stays at its commit.
  for (const value of ["true", "yes"]) {
    expect(install({ DORI_NO_PULL: value }).code).toBe(0);
    expect(git(src, "rev-parse", "HEAD")).toBe(before);
  }
  // And with 0 it pulls as usual.
  expect(install({ DORI_NO_PULL: "0" }).code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
});

test("a branch with no upstream is not taken for local work: git's reason, no reset suggested", () => {
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

test("a failed fetch is not taken for local work: no reset is suggested", () => {
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

test("the OMP extension and explicit ULW path install without replacing existing owner configuration", () => {
  const { home, src, ulw, install } = setup();
  mkdirSync(join(home, ".dori"));
  writeFileSync(join(home, ".dori/.omp-dori"), "primary\n");
  const path = join(home, ".dori/config.json");
  writeFileSync(
    path,
    JSON.stringify({
      defaultModel: "provider/custom",
      hooks: { threadReply: ["fixture"] },
      ompUlwPath: "/previous/index.ts",
    }),
  );
  expect(install().code).toBe(0);
  expect(readlinkSync(join(home, "extensions/omp-dori"))).toBe(join(src, "extension"));
  // omp-ulw becomes an OMP extension, so the config's import path is emptied rather than pointed at it.
  expect(readlinkSync(join(home, "extensions/omp-ulw"))).toBe(ulw);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    defaultModel: "provider/custom",
    hooks: { threadReply: ["fixture"] },
    ompUlwPath: "",
  });
});

test("an existing non-link extension directory is preserved and stops installation", () => {
  const { home, install } = setup();
  const extension = join(home, "extensions/omp-dori");
  mkdirSync(extension, { recursive: true });
  writeFileSync(join(extension, "owner.txt"), "keep\n");
  expect(install().code).toBe(1);
  expect(readFileSync(join(extension, "owner.txt"), "utf8")).toBe("keep\n");
});

test("the full upstream harness Bun requirement is checked before changing the checkout", () => {
  const { upstreamCommit, src, install } = setup();
  const before = git(src, "rev-parse", "HEAD");
  upstreamCommit("v2\n");
  expect(install({ INSTALL_TEST_BUN_VERSION: "1.3.0" }).code).toBe(1);
  expect(git(src, "rev-parse", "HEAD")).toBe(before);
});
