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
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cataly-cli-native-")));
  roots.push(home);
  const source = join(home, ".cataly/releases/releases", `${"a".repeat(40)}-${"b".repeat(16)}`);
  const root = resolve(import.meta.dir, "..");
  const f = overlayFixture(source, join(home, "upstream"));
  for (const tree of ["src", "skills/cataly-mode/scripts/src"])
    cpSync(join(root, tree), join(source, tree), { recursive: true });
  cpSync(join(root, "package.json"), join(source, "package.json"));
  const receipt = nativeCacheFixture(source, home, f.checkout);
  const manifests = join(home, ".cataly/releases/consumer-manifests");
  mkdirSync(manifests, { recursive: true, mode: 0o700 });
  writeFileSync(join(manifests, `${basename(source)}.json`), JSON.stringify({ requirements: { omp: "19.0.1" } }), {
    mode: 0o600,
  });
  const state = join(home, "state");
  mkdirSync(join(state, "lanes"), { recursive: true });
  writeFileSync(join(state, "lanes/fixture.json"), JSON.stringify({ key: "fixture", status: "working" }));
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state, agentCommand: ["omp"] }));
  const cli = join(source, "skills/cataly-mode/scripts/src/cli.ts");
  const invoke = (preload?: string) =>
    Bun.spawnSync([process.execPath, ...(preload ? ["--preload", preload] : []), cli, "checkpoints", "fixture"], {
      env: { HOME: home, PATH: process.env["PATH"], CATALY_CONFIG: config, CATALY_TELEMETRY: "0", DO_NOT_TRACK: "1" },
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cataly-cli-external-")));
  roots.push(home);
  const source = join(home, ".cataly/releases/releases", `${"a".repeat(40)}-${"b".repeat(16)}`);
  const root = resolve(import.meta.dir, "..");
  mkdirSync(source, { recursive: true });
  for (const tree of ["src", "skills/cataly-mode/scripts/src"])
    cpSync(join(root, tree), join(source, tree), { recursive: true });
  cpSync(join(root, "package.json"), join(source, "package.json"));
  const stateDir = join(home, "state");
  mkdirSync(join(stateDir, "lanes"), { recursive: true });
  writeFileSync(join(stateDir, "lanes/fixture.json"), JSON.stringify({ key: "fixture", status: "working" }));
  const config = join(home, "config.json");
  const invoke = (executable: string, cwd = home) => {
    writeFileSync(config, JSON.stringify({ stateDir, agentCommand: [executable] }));
    return Bun.spawnSync(
      [process.execPath, join(source, "skills/cataly-mode/scripts/src/cli.ts"), "checkpoints", "fixture"],
      {
        cwd,
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: process.env["PATH"],
          CATALY_CONFIG: config,
          CATALY_TELEMETRY: "0",
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

  const managedPaths = ["omp", join(home, ".cataly", "bin", "omp"), join(source, "scripts", "consumer", "omp")];
  if (process.platform === "win32") {
    const drive = parse(home).root;
    assertExternal(join(drive, "bin", "omp"), join(home, ".cataly"));
    assertExternal(join(drive, basename(source), "scripts", "consumer", "omp"), join(source, ".."));
    const alias = join(home, "cataly-junction");
    symlinkSync(join(home, ".cataly"), alias, "junction");
    managedPaths.push(
      join(alias, "bin", "omp"),
      join(alias, "releases", "releases", basename(source), "scripts", "consumer", "omp"),
    );
  }
  // Windows may name the temp root by its 8.3 short form; the error names the long one, as realpathSync.native does.
  const lock = join(realpathSync.native(source), "native-omp.lock");
  for (const executable of managedPaths) {
    const managed = invoke(executable);
    expect(managed.exitCode === 0 ? { unexpectedlyAccepted: executable } : null).toBeNull();
    expect(managed.stdout.toString()).toBe("");
    expect(managed.stderr.toString()).toContain(lock);
  }
}, 20_000);
