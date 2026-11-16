import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(version = "18.20.0") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-legacy-prerequisite-")));
  roots.push(root);
  const home = join(root, "home");
  const tools = join(root, "tools");
  const independent = join(root, "independent");
  const alias = join(root, "alias");
  const managed = join(home, ".dori/bin");
  const target = join(home, ".dori/releases/releases/current/scripts/consumer/omp");
  for (const path of [tools, independent, alias, managed, dirname(target)])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const name of ["git", "herdr"]) symlinkSync(process.execPath, join(tools, name));
  for (const [path, label] of [
    [target, "managed"],
    [join(independent, "omp"), "independent"],
  ] as const)
    writeFileSync(path, `#!/bin/sh\nprintf '${version}\\n'\nprintf '${label}' > "$HOME/executed"\n`, {
      mode: 0o700,
    });
  symlinkSync(target, join(managed, "omp"));
  symlinkSync(join(managed, "omp"), join(alias, "omp"));
  // Exercise command selection on every CI host; platform admission is checked separately below.
  const run = (directories: readonly string[], command?: string, platform = "linux", arch = "x64") => {
    if (command)
      writeFileSync(join(home, ".dori/config.json"), JSON.stringify({ agentCommand: [command] }), { mode: 0o600 });
    return Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `import { prerequisites } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/provision.ts"))};
Object.defineProperties(process, {
  platform: { value: ${JSON.stringify(platform)} },
  arch: { value: ${JSON.stringify(arch)} },
});
prerequisites(true);`,
      ],
      { env: { HOME: home, PATH: [...directories, tools].join(":") }, stdout: "pipe", stderr: "pipe" },
    );
  };
  return { home, independent, alias, managed, run };
}

for (const scenario of ["managed-only", "alias", "independent-behind", "configured-managed", "configured-alias"])
  test(`legacy activation holds before executing a disappearing command: ${scenario}`, () => {
    const f = fixture();
    const directories =
      scenario === "alias"
        ? [f.alias]
        : scenario.startsWith("configured-")
          ? [f.independent, f.managed]
          : scenario === "independent-behind"
            ? [f.managed, f.independent]
            : [f.managed];
    const command = scenario.startsWith("configured-")
      ? join(scenario === "configured-managed" ? f.managed : f.alias, "omp")
      : undefined;
    const result = f.run(directories, command);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("independently installed OMP");
    expect(existsSync(join(f.home, "executed"))).toBe(false);
  });

test("legacy activation accepts a surviving independent command without rewriting configured arguments", () => {
  const f = fixture();
  const command = join(f.independent, "omp");
  const result = f.run([f.independent, f.managed], command);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("independent");
  expect(JSON.parse(readFileSync(join(f.home, ".dori/config.json"), "utf8"))).toEqual({ agentCommand: [command] });
});

test("legacy activation still enforces the independent native version minimum", () => {
  const f = fixture("18.18.7");
  const result = f.run([f.independent]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("OMP 18.18.8+");
});

test("legacy activation holds when no native command is available", () => {
  const f = fixture();
  const result = f.run([]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("independently installed OMP");
  expect(existsSync(join(f.home, "executed"))).toBe(false);
});

for (const [platform, arch] of [
  ["darwin", "arm64"],
  ["linux", "arm64"],
] as const)
  test(`legacy activation retains platform admission: ${platform}/${arch}`, () => {
    const f = fixture();
    const result = f.run([f.independent], undefined, platform, arch);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("This release supports Linux x64");
    expect(existsSync(join(f.home, "executed"))).toBe(false);
  });
