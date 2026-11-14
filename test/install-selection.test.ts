import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, withUlwRemote } from "./install-setup.ts";

test.each(["", "/../omp-ulw"])(
  "selecting an existing side default%s clears the external choice and restores managed ref updates",
  (suffix) => {
    const { root, home, remote, first, commit, install } = withUlwRemote();
    const side = join(home, ".omp-dori");
    const managed = join(side, "omp-ulw");
    const retained = join(side, ".omp-dori-ulw");
    expect(install({ DORI_INSTALL_MODE: "side" }).code).toBe(0);
    const external = join(home, "owner-ulw");
    git(root, "clone", "-q", remote, external);
    expect(install({ OMP_ULW_SRC: external }).code).toBe(0);
    expect(readlinkSync(retained)).toBe(external);
    const latest = commit("u2");

    expect(install({ OMP_ULW_SRC: `${managed}${suffix}` }).code).toBe(0);
    expect(lstatSync(retained, { throwIfNoEntry: false })).toBeUndefined();
    expect(git(managed, "rev-parse", "HEAD")).toBe(first);
    expect(install().code).toBe(0);
    expect(git(managed, "rev-parse", "HEAD")).toBe(latest);
    expect(lstatSync(retained, { throwIfNoEntry: false })).toBeUndefined();
    expect(git(external, "rev-parse", "HEAD")).toBe(first);
    expect(install({ OMP_ULW_REF: "lock" }).code).toBe(0);
    expect(git(managed, "rev-parse", "HEAD")).toBe(first);
    expect(lstatSync(retained, { throwIfNoEntry: false })).toBeUndefined();
    expect(JSON.parse(readFileSync(join(side, "config.json"), "utf8")).ompUlwPath).toBe("");
    expect(existsSync(join(home, ".dori"))).toBe(false);
    expect(existsSync(join(home, "extensions"))).toBe(false);
  },
);

test.each([
  ["side repeated slash", "", "//", "side"],
  ["primary default with parent HOME", "/../home", "", "primary"],
])("a legacy side config keeps implicit managed ref selection with %s", (_label, homeSuffix, sideSuffix, kind) => {
  const { root, home, remote, first, commit, install } = withUlwRemote();
  const side = join(home, ".omp-dori");
  const managed = join(side, "omp-ulw");
  mkdirSync(side);
  git(root, "clone", "-q", remote, managed);
  writeFileSync(join(side, ".omp-dori"), "side\n");
  const rawHome = `${home}${homeSuffix}`;
  const rawSide = `${rawHome}/.omp-dori${sideSuffix}`;
  const options = { HOME: rawHome, OMP_DORI_HOME: homeSuffix ? "" : rawSide };
  const configPath = join(side, "config.json");
  const config = {
    ompUlwPath: kind === "primary" ? join(home, ".dori/omp-ulw/index.ts") : `${rawSide}/omp-ulw/index.ts`,
    defaultModel: "fixture/preserved",
    agentCommand: ["fixture-omp", "{prompt}"],
  };
  writeFileSync(configPath, JSON.stringify(config));
  const latest = commit("u2");

  expect(install(options).code).toBe(0);
  expect(git(managed, "rev-parse", "HEAD")).toBe(latest);
  expect(lstatSync(join(side, ".omp-dori-ulw"), { throwIfNoEntry: false })).toBeUndefined();
  expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ ...config, ompUlwPath: "" });
  const saved = readFileSync(configPath, "utf8");
  expect(install({ ...options, OMP_ULW_REF: "lock" }).code).toBe(0);
  expect(git(managed, "rev-parse", "HEAD")).toBe(first);
  expect(lstatSync(join(side, ".omp-dori-ulw"), { throwIfNoEntry: false })).toBeUndefined();
  expect(readFileSync(configPath, "utf8")).toBe(saved);
  expect(existsSync(join(home, ".dori"))).toBe(false);
  expect(existsSync(join(home, "extensions"))).toBe(false);
});

test("a non-normalized custom config retains its real checkout without fetching or selecting a managed ref", () => {
  const { root, home, remote, first, commit, install } = withUlwRemote();
  const side = join(home, ".omp-dori");
  const external = join(home, "owner-ulw");
  const unreachable = join(root, "missing-remote");
  git(root, "clone", "-q", remote, external);
  git(external, "remote", "set-url", "origin", unreachable);
  mkdirSync(side);
  writeFileSync(join(side, ".omp-dori"), "side\n");
  const configPath = join(side, "config.json");
  writeFileSync(configPath, JSON.stringify({ ompUlwPath: `${external}/../owner-ulw/./index.ts` }));
  const options = { OMP_DORI_HOME: `${side}/../.omp-dori//` };
  commit("u2");

  expect(install(options).code).toBe(0);
  expect(readlinkSync(join(side, ".omp-dori-ulw"))).toBe(external);
  expect(git(external, "rev-parse", "HEAD")).toBe(first);
  expect(install({ ...options, OMP_ULW_REF: "main" }).code).toBe(0);
  expect(readlinkSync(join(side, ".omp-dori-ulw"))).toBe(external);
  expect(git(external, "rev-parse", "HEAD")).toBe(first);
  expect(git(external, "remote", "get-url", "origin")).toBe(unreachable);
  expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ ompUlwPath: "" });
  expect(existsSync(join(side, "omp-ulw"))).toBe(false);
});

test("selecting the managed default preserves a foreign regular retention path before checkout or config changes", () => {
  const { home, src, first, commit, upstreamCommit, install } = withUlwRemote();
  const side = join(home, ".omp-dori");
  const managed = join(side, "omp-ulw");
  const retained = join(side, ".omp-dori-ulw");
  expect(install({ DORI_INSTALL_MODE: "side" }).code).toBe(0);
  const sourceHead = git(src, "rev-parse", "HEAD");
  const config = readFileSync(join(side, "config.json"), "utf8");
  writeFileSync(retained, "owner data\n");
  upstreamCommit("pending source update\n");
  commit("u2");

  expect(install({ OMP_ULW_SRC: `${managed}/.` }).code).toBe(1);
  expect(readFileSync(retained, "utf8")).toBe("owner data\n");
  expect(lstatSync(retained).isFile()).toBe(true);
  expect(git(src, "rev-parse", "HEAD")).toBe(sourceHead);
  expect(git(managed, "rev-parse", "HEAD")).toBe(first);
  expect(readFileSync(join(side, "config.json"), "utf8")).toBe(config);
});
