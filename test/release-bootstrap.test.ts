import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { darwin, fixture, linux } from "./release-bootstrap-setup.ts";

// POSIX-only: the fixture runs install.sh under bash with shebang tool stubs through a ':' PATH.
const posix = test.skipIf(process.platform === "win32");

posix.each([
  [linux, ".dori", "herdr"],
  [darwin, ".omp-dori", "hc"],
] as const)(
  "default bootstrap selects the supported installation and runtime on $platform",
  (profile, folder, runtime) => {
    const f = fixture(profile);
    const result = f.run([], {
      DORI_HOME: join(f.root, "foreign"),
      DORI_CONFIG: join(f.root, "foreign-config"),
      DORI_STATE_DIR: join(f.root, "foreign-state"),
      DORI_CMD: "foreign-command",
      DORI_AGENT_CMD: "foreign-agent",
      DORI_AGENT_ARGV: '["/foreign/omp"]',
      DORI_OMP_ULW_PATH: "/foreign/ulw/index.ts",
      DORI_MANAGED_STARTUP: "1",
    });
    expect(result.exitCode).toBe(0);
    expect(f.selected()).toEqual(f.expected(join(f.home, folder), runtime));
    expect(existsSync(join(f.root, "foreign"))).toBe(false);
  },
);

posix("explicit home wins over side environment and leaves primary and global files untouched", () => {
  const f = fixture(darwin);
  const primary = join(f.home, ".dori"),
    global = join(f.home, ".agents/skills/dori-mode");
  mkdirSync(primary);
  mkdirSync(dirname(global), { recursive: true });
  writeFileSync(join(primary, "sentinel"), "primary");
  writeFileSync(global, "global");
  const selected = join(f.root, "selected");
  const result = f.run(["--home", selected, "--runtime", "hc"], {
    DORI_INSTALL_MODE: "side",
    OMP_DORI_HOME: join(f.root, "other"),
    DORI_RUNTIME: "herdr",
  });
  expect(result.exitCode).toBe(0);
  expect(f.selected()).toEqual(f.expected(selected, "hc"));
  expect(readFileSync(join(primary, "sentinel"), "utf8")).toBe("primary");
  expect(readFileSync(global, "utf8")).toBe("global");
});

posix("side mode honors its home and explicit runtime environment", () => {
  const f = fixture(linux),
    selected = join(f.root, "side");
  const result = f.run([], { DORI_INSTALL_MODE: "side", OMP_DORI_HOME: selected, DORI_RUNTIME: "herdr" });
  expect(result.exitCode).toBe(0);
  expect(f.selected()).toEqual(f.expected(selected, "herdr"));
});

posix("an explicit primary home overrides the Darwin side default", () => {
  const f = fixture(darwin),
    selected = join(f.home, ".dori");
  const result = f.run(["--home", selected]);
  expect(result.exitCode).toBe(0);
  expect(f.selected()).toEqual(f.expected(selected, "hc"));
});

test("side home resolving under primary is rejected before assets are read", () => {
  const f = fixture(linux);
  mkdirSync(join(f.home, ".dori"));
  symlinkSync(join(f.home, ".dori"), join(f.root, "alias"));
  rmSync(f.dist, { recursive: true });
  const result = f.run(["--home", join(f.root, "alias", "nested")], { DORI_INSTALL_MODE: "side" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("outside ~/.dori");
  expect(existsSync(join(f.home, ".dori", "nested"))).toBe(false);
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

test("unsupported host runtime is rejected before assets are read", () => {
  const f = fixture(darwin);
  rmSync(f.dist, { recursive: true });
  const result = f.run(["--runtime", "herdr"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Unsupported host/runtime");
  expect(existsSync(join(f.home, ".omp-dori"))).toBe(false);
});

posix.each([".omp-dori", ".git", "src/.git", "bin/dori", "bin/omp"])(
  "source-owned or custom wrapper %s is held before assets are read",
  (path) => {
    const f = fixture(linux),
      target = join(f.home, ".dori", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "existing");
    rmSync(f.dist, { recursive: true });
    const result = f.run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(/Source-owned|Unmanaged wrapper/);
    expect(readFileSync(target, "utf8")).toBe("existing");
  },
);

posix.each([
  { value: undefined, error: "Release does not support" },
  { value: { version: 1, profiles: [] }, error: "Invalid release capabilities" },
  { value: { version: 1, profiles: [darwin, darwin] }, error: "duplicate release capability" },
  { value: { version: 1, profiles: [darwin, { ...linux, extra: true }] }, error: "Invalid release capability" },
  { value: { version: 1, profiles: [{ ...darwin, platform: ["darwin"] }] }, error: "Invalid release capability" },
  {
    value: { version: 1, profiles: [darwin, { ...linux, runtime: "hc" }] },
    error: "Invalid or duplicate release capability",
  },
  { value: { version: 1, profiles: [linux] }, error: "Release does not support" },
] as const)("rejects unsupported or malformed source capabilities before extraction", ({ value, error }) => {
  const f = fixture(darwin);
  f.assets(value);
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(error);
  expect(existsSync(f.result)).toBe(false);
});

posix("legacy Linux herdr installs in the primary home with its strict CLI", () => {
  const f = fixture(linux);
  f.assets();
  const result = f.run([], {
    DORI_HOME: join(f.root, "foreign"),
    DORI_CONFIG: join(f.root, "foreign-config"),
    DORI_STATE_DIR: join(f.root, "foreign-state"),
    DORI_RUNTIME: "herdr",
    DORI_CMD: "foreign-command",
    DORI_AGENT_CMD: "foreign-agent",
  });
  expect(result.exitCode).toBe(0);
  expect(f.selected()).toEqual(f.expected(join(f.home, ".dori"), "herdr"));
  expect(readFileSync(join(f.home, ".dori", "legacy-installed"), "utf8")).toBe("installed");
  expect(existsSync(join(f.root, "foreign"))).toBe(false);
});

posix("legacy releases reject a side home without mutating either installation", () => {
  const f = fixture(linux);
  const primary = join(f.home, ".dori"),
    side = join(f.root, "side");
  mkdirSync(primary);
  writeFileSync(join(primary, "sentinel"), "primary");
  f.assets();
  const result = f.run([], { DORI_INSTALL_MODE: "side", OMP_DORI_HOME: side });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Legacy release requires the primary");
  expect(existsSync(f.result)).toBe(false);
  expect(existsSync(side)).toBe(false);
  expect(existsSync(join(primary, "legacy-installed"))).toBe(false);
  expect(readFileSync(join(primary, "sentinel"), "utf8")).toBe("primary");
});

posix("archive checksum mismatch prevents executing the extracted consumer", () => {
  const f = fixture(linux);
  writeFileSync(join(f.dist, "omp-dori-v1.2.3.tar.gz"), "tampered");
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Release checksum differs");
  expect(existsSync(f.result)).toBe(false);
  expect(existsSync(join(f.home, ".dori"))).toBe(false);
});

test.each(["flag", "environment"] as const)("bootstrap rejects a relative %s home before reading assets", (kind) => {
  const f = fixture(linux);
  rmSync(f.dist, { recursive: true });
  const result = f.run(kind === "flag" ? ["--home", "relative-home"] : [], {
    DORI_INSTALL_MODE: "side",
    OMP_DORI_HOME: "relative-home",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("must be an absolute installation home");
  expect(existsSync(f.result)).toBe(false);
});

posix.each([true, false])(
  "bootstrap preserves primary native ownership while checking its target (valid=%s)",
  (valid) => {
    const f = fixture(linux);
    const home = join(f.home, ".dori");
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
      expect(f.selected()).toEqual(f.expected(home, "herdr"));
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Unmanaged wrapper");
      expect(existsSync(f.result)).toBe(false);
    }
    expect(readFileSync(target, "utf8")).toBe("owner bytes\n");
    expect(readFileSync(join(home, "releases/consumer-owner.json"), "utf8")).toBe(owner);
  },
);
