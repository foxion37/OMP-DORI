import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

// POSIX-only: native admission fixtures build private directories that POSIX mode bits mark.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

posix("a lightweight command in a consumer release still validates every native byte before handler loading", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dori-cli-native-")));
  roots.push(home);
  const source = join(home, ".dori/releases/releases", `${"a".repeat(40)}-${"b".repeat(16)}`);
  const root = resolve(import.meta.dir, "..");
  const f = overlayFixture(source, join(home, "upstream"), true);
  for (const tree of ["src", "skills/dori-mode/scripts/src"])
    cpSync(join(root, tree), join(source, tree), { recursive: true });
  cpSync(join(root, "package.json"), join(source, "package.json"));
  const receipt = nativeCacheFixture(source, home, f.checkout);
  const manifests = join(home, ".dori/releases/consumer-manifests");
  mkdirSync(manifests, { recursive: true, mode: 0o700 });
  writeFileSync(join(manifests, `${basename(source)}.json`), JSON.stringify({ requirements: { omp: "18.20.0" } }), {
    mode: 0o600,
  });
  const state = join(home, "state");
  mkdirSync(join(state, "lanes"), { recursive: true });
  writeFileSync(join(state, "lanes/fixture.json"), JSON.stringify({ key: "fixture", status: "working" }));
  const config = join(home, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ runtime: "herdr", stateDir: state, agentCommand: ["omp"], ompUlwPath: "/explicit-ulw" }),
  );
  const cli = join(source, "skills/dori-mode/scripts/src/cli.ts");
  const invoke = (preload?: string) =>
    Bun.spawnSync([process.execPath, ...(preload ? ["--preload", preload] : []), cli, "checkpoints", "fixture"], {
      env: { HOME: home, PATH: process.env["PATH"], DORI_CONFIG: config, DORI_TELEMETRY: "0", DO_NOT_TRACK: "1" },
      timeout: 15_000,
      stdout: "pipe",
      stderr: "pipe",
    });
  const valid = invoke();
  expect({ code: valid.exitCode, out: valid.stdout.toString(), err: valid.stderr.toString() }).toEqual({
    code: 0,
    out: "[]\n",
    err: "",
  });
  writeFileSync(receipt.addon, "tampered native bytes");
  const preload = join(home, "handler-guard.ts");
  // The loader trap proves that native admission rejects drift before the lightweight handler is even loaded.
  writeFileSync(
    preload,
    `import { plugin } from "bun";
plugin({ name: "handler-guard", setup(build) {
  build.onLoad({ filter: /cli-journal[.]ts$/ }, () => { throw new Error("HANDLER_LOADED_BEFORE_ADMISSION"); });
} });`,
  );
  const invalid = invoke(preload);
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stderr.toString()).toContain("receipt differs");
  expect(invalid.stderr.toString()).not.toContain("HANDLER_LOADED_BEFORE_ADMISSION");
  expect(invalid.stdout.toString()).toBe("");
});

test("an explicitly configured external OMP needs no native receipt, but the managed default still does", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dori-cli-external-")));
  roots.push(home);
  const source = join(home, ".dori/releases/releases", `${"a".repeat(40)}-${"b".repeat(16)}`);
  const root = resolve(import.meta.dir, "..");
  mkdirSync(source, { recursive: true });
  for (const tree of ["src", "skills/dori-mode/scripts/src"])
    cpSync(join(root, tree), join(source, tree), { recursive: true });
  cpSync(join(root, "package.json"), join(source, "package.json"));
  const stateDir = join(home, "state");
  mkdirSync(join(stateDir, "lanes"), { recursive: true });
  writeFileSync(join(stateDir, "lanes/fixture.json"), JSON.stringify({ key: "fixture", status: "working" }));
  const config = join(home, "config.json");
  const invoke = (executable: string, cwd = home) => {
    writeFileSync(config, JSON.stringify({ stateDir, agentCommand: [executable], ompUlwPath: "/explicit-ulw" }));
    return Bun.spawnSync(
      [process.execPath, join(source, "skills/dori-mode/scripts/src/cli.ts"), "checkpoints", "fixture"],
      {
        cwd,
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: process.env["PATH"],
          DORI_CONFIG: config,
          DORI_TELEMETRY: "0",
          DO_NOT_TRACK: "1",
        },
        timeout: 15_000,
      },
    );
  };
  const assertExternal = (executable: string, cwd?: string) => {
    const run = invoke(executable, cwd);
    expect({ executable, code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }).toEqual({
      executable,
      code: 0,
      out: "[]\n",
      err: "",
    });
  };
  const externalBin = join(home, "external", "bin");
  mkdirSync(externalBin, { recursive: true });
  assertExternal(join(externalBin, "omp"));

  const managedPaths = ["omp", join(home, ".dori", "bin", "omp"), join(source, "scripts", "consumer", "omp")];
  if (process.platform === "win32") {
    const drive = parse(home).root;
    assertExternal(join(drive, "bin", "omp"), join(home, ".dori"));
    assertExternal(join(drive, basename(source), "scripts", "consumer", "omp"), join(source, ".."));
    const alias = join(home, "dori-junction");
    symlinkSync(join(home, ".dori"), alias, "junction");
    managedPaths.push(
      join(alias, "bin", "omp"),
      join(alias, "releases", "releases", basename(source), "scripts", "consumer", "omp"),
    );
  }
  for (const executable of managedPaths) {
    const managed = invoke(executable);
    expect(managed.exitCode === 0 ? { unexpectedlyAccepted: executable } : null).toBeNull();
    expect(managed.stdout.toString()).toBe("");
    expect(managed.stderr.toString()).toContain("consumer-manifests");
  }
}, 20_000);
