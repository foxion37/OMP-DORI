import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { darwin, fixture, linux } from "./release-bootstrap-setup.ts";

// POSIX-only: the fixture runs install.sh under bash with shebang tool stubs through a ':' PATH.
const posix = test.skipIf(process.platform === "win32");

posix.each([
  [linux, ".cataly"],
  [darwin, ".omp-cataly"],
] as const)("default bootstrap selects the supported installation on $platform", (profile, folder) => {
  const f = fixture(profile);
  const result = f.run([], {
    CATALY_HOME: join(f.root, "foreign"),
    CATALY_CONFIG: join(f.root, "foreign-config"),
    CATALY_STATE_DIR: join(f.root, "foreign-state"),
    CATALY_RUNTIME: "tern",
    CATALY_CMD: "foreign-command",
    CATALY_AGENT_CMD: "foreign-agent",
    CATALY_AGENT_ARGV: '["/foreign/omp"]',
    CATALY_MANAGED_STARTUP: "1",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(join(f.home, folder)));
  expect(existsSync(join(f.root, "foreign"))).toBe(false);
});

posix("explicit home wins over side environment and leaves primary and global files untouched", () => {
  const f = fixture(darwin);
  const primary = join(f.home, ".cataly"),
    global = join(f.home, ".agents/skills/cataly-mode");
  mkdirSync(primary);
  mkdirSync(dirname(global), { recursive: true });
  writeFileSync(join(primary, "sentinel"), "primary");
  writeFileSync(global, "global");
  const selected = join(f.root, "selected");
  const result = f.run(["--home", selected], { CATALY_INSTALL_MODE: "side", OMP_CATALY_HOME: join(f.root, "other") });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(selected));
  expect(readFileSync(join(primary, "sentinel"), "utf8")).toBe("primary");
  expect(readFileSync(global, "utf8")).toBe("global");
});

posix("side mode honors its home environment", () => {
  const f = fixture(linux),
    selected = join(f.root, "side");
  const result = f.run([], { CATALY_INSTALL_MODE: "side", OMP_CATALY_HOME: selected });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(selected));
});

posix("an explicit primary home overrides the Darwin side default", () => {
  const f = fixture(darwin),
    selected = join(f.home, ".cataly");
  const result = f.run(["--home", selected]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(selected));
});

test("a side home resolving under the primary home is rejected before assets are read", () => {
  const f = fixture(linux);
  const primary = join(f.home, ".cataly");
  mkdirSync(primary);
  symlinkSync(primary, join(f.root, "alias"));
  rmSync(f.dist, { recursive: true });
  const result = f.run(["--home", join(f.root, "alias", "nested")], { CATALY_INSTALL_MODE: "side" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(`outside ${primary}`);
  expect(existsSync(join(primary, "nested"))).toBe(false);
});

test.each(["home", "parent"] as const)("side %s containing primary is rejected before assets are read", (selection) => {
  const f = fixture(linux);
  rmSync(f.dist, { recursive: true });
  const selected = selection === "home" ? f.home : dirname(f.home);
  const result = f.run(["--home", selected]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("must not contain");
  expect(existsSync(join(selected, "src"))).toBe(false);
});

posix.each([[["--runtime", "tern"]], [["--session", "original"]]])(
  "unknown option %p is rejected before assets are read",
  (args: string[]) => {
    const f = fixture(linux);
    rmSync(f.dist, { recursive: true });
    const result = f.run(args);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(f.result)).toBe(false);
  },
);

posix.each([".omp-cataly", ".git", "src/.git", "bin/cataly", "bin/omp"])(
  "source-owned or custom wrapper %s is held before assets are read",
  (path) => {
    const f = fixture(linux),
      target = join(f.home, ".cataly", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "existing");
    rmSync(f.dist, { recursive: true });
    const result = f.run(["--home", join(f.home, ".cataly")]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(/Source-owned|Unmanaged wrapper/);
    expect(readFileSync(target, "utf8")).toBe("existing");
  },
);

posix.each([
  { value: undefined, error: "has no bound headless profile" },
  { value: { version: 1, profiles: [] }, error: "Invalid release capabilities" },
  { value: { version: 1, profiles: [darwin, darwin] }, error: "duplicate release capability" },
  { value: { version: 1, profiles: [darwin, { ...linux, extra: true }] }, error: "Invalid release capability" },
  { value: { version: 1, profiles: [{ ...darwin, platform: ["darwin"] }] }, error: "Invalid release capability" },
  {
    value: { version: 1, profiles: [{ ...darwin, runtime: "tern" }] },
    error: "Invalid or duplicate release capability",
  },
  { value: { version: 1, profiles: [linux] }, error: "Release does not support this host" },
] as const)("rejects missing, unsupported or malformed capabilities before extraction", ({ value, error }) => {
  const f = fixture(darwin);
  f.assets(value);
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(error);
  expect(existsSync(f.result)).toBe(false);
});

posix("archive checksum mismatch prevents executing the extracted consumer", () => {
  const f = fixture(linux);
  writeFileSync(join(f.dist, "cataly-v1.2.3.tar.gz"), "tampered");
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Release checksum differs");
  expect(existsSync(f.result)).toBe(false);
  expect(existsSync(join(f.home, ".cataly"))).toBe(false);
});

test.each(["flag", "environment"] as const)("bootstrap rejects a relative %s home before reading assets", (kind) => {
  const f = fixture(linux);
  rmSync(f.dist, { recursive: true });
  const result = f.run(kind === "flag" ? ["--home", "relative-home"] : [], {
    CATALY_INSTALL_MODE: "side",
    OMP_CATALY_HOME: "relative-home",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("must be an absolute installation home");
  expect(existsSync(f.result)).toBe(false);
});

posix.each([true, false])(
  "bootstrap preserves primary native ownership while checking its target (valid=%s)",
  (valid) => {
    const f = fixture(linux);
    const home = join(f.home, ".cataly");
    const release = join(home, "releases/releases", `${"a".repeat(40)}-${"b".repeat(16)}`);
    const target = join(release, valid ? "scripts/consumer/omp" : "owner-command");
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(join(home, "bin"));
    writeFileSync(target, "owner bytes\n");
    const owner = JSON.stringify({ version: 1, home: f.home, liveSource: join(home, "src") });
    writeFileSync(join(home, "releases/consumer-owner.json"), owner);
    symlinkSync(release, join(home, "src"));
    symlinkSync(target, join(home, "bin/omp"));
    const result = f.run();
    if (valid) {
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(f.selected()).toEqual(f.expected(home));
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Unmanaged wrapper");
      expect(existsSync(f.result)).toBe(false);
    }
    expect(readFileSync(target, "utf8")).toBe("owner bytes\n");
    expect(readFileSync(join(home, "releases/consumer-owner.json"), "utf8")).toBe(owner);
  },
);
