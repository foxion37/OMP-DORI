import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { darwin, fixture, linux } from "./release-bootstrap-setup.ts";

// POSIX-only: the fixture runs install.sh under bash with shebang tool stubs.
const posix = test.skipIf(process.platform === "win32");

posix.each([
  ['{"runtime":"headless"}', "Preserved config runtime must be tern when present"],
  ['{"sessionRuntime":"terminal"}', "Preserved config sessionRuntime must be headless or tern when present"],
])("a preserved config %s fails ordinary validation and is never rewritten", (preserved, error) => {
  const f = fixture(linux);
  const home = join(f.home, ".cataly"),
    config = join(home, "config.json");
  mkdirSync(home);
  writeFileSync(config, preserved);
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(error);
  expect(readFileSync(config, "utf8")).toBe(preserved);
  expect(existsSync(f.result)).toBe(false);
});

posix("a headless config without runtime keys installs and keeps its bytes", () => {
  const f = fixture(linux);
  const home = join(f.home, ".cataly"),
    config = join(home, "config.json");
  mkdirSync(home);
  const preserved = '{"sessionRuntime":"headless","ownerValue":"keep"}\n';
  writeFileSync(config, preserved);
  const result = f.run();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(home));
  expect(readFileSync(config, "utf8")).toBe(preserved);
});

posix("a Tern config installs headless and keeps its bytes", () => {
  const f = fixture(linux);
  const home = join(f.home, ".cataly"),
    config = join(home, "config.json");
  mkdirSync(home);
  const preserved = '{"runtime":"tern","sessionRuntime":"tern","laneRuntime":"terminal"}\n';
  writeFileSync(config, preserved);
  writeFileSync(join(home, "roles.json"), '{"lead":"tern:7"}\n');
  const result = f.run();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(home));
  expect(readFileSync(config, "utf8")).toBe(preserved);
});

posix.each([
  [linux, "19.0.1"],
  [darwin, "19.0.1"],
  [linux, "19.2.0"],
  [darwin, "19.2.0"],
] as const)("headless bootstrap installs %j with OMP %s", (profile, version) => {
  const f = fixture(profile);
  f.assets({ version: 1, profiles: [linux, darwin] }, version);
  const home = join(f.home, ".omp-cataly");
  const result = f.run(["--home", home]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(home));
});

posix.each(["18.20.0", "19.0.1-rc.1", "20.0.0"])("headless bootstrap refuses unsupported OMP %s", (version) => {
  const f = fixture(linux);
  f.assets({ version: 1, profiles: [linux] }, version);
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("has no bound headless profile");
  expect(existsSync(f.result)).toBe(false);
});

posix("an existing roles.json does not hold installation", () => {
  const f = fixture(linux);
  const home = join(f.home, ".cataly");
  mkdirSync(home);
  writeFileSync(join(home, "roles.json"), '{"lead":"headless:lead-1"}\n');
  const result = f.run();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
