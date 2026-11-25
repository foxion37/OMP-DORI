import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { checkTestFixtures } from "../scripts/check-test-fixtures.ts";
import nativeFixture from "./fixtures/omp-native-host/package.json";

const source = resolve(import.meta.dir, "..");
const nativeHost = join(source, "test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cataly-ci-fixtures-"));
  roots.push(root);
  return { root, env: { CATALY_TEST_OMP_ROOT: nativeHost } };
}

test.each([
  ["@oh-my-pi/pi-coding-agent", "index.d.ts"],
  ["@oh-my-pi/pi-coding-agent/extensibility/extensions/loader", "extensibility/extensions/loader.d.ts"],
] as const)(
  "extension type import %s resolves from the exact CI host, not an optional peer install",
  (specifier, declaration) => {
    const configFile = join(source, "extension/tsconfig.json");
    const raw = ts.readConfigFile(configFile, ts.sys.readFile);
    expect(raw.error).toBeUndefined();
    const config = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(configFile));
    expect(config.errors).toEqual([]);
    const resolved = ts.resolveModuleName(specifier, join(source, "extension/lane-policy.ts"), config.options, ts.sys);
    const file = resolved.resolvedModule?.resolvedFileName;
    expect(file && realpathSync.native(file)).toBe(realpathSync.native(join(nativeHost, "dist/types", declaration)));
  },
);

test("the prerequisite check accepts the actual exact native host", async () => {
  const f = fixture();
  expect((await checkTestFixtures(f.root, f.env)).native.root).toBe(realpathSync(nativeHost));
});

test.each([undefined, "relative/native"])("an absent or relative native host is refused: %j", async (host) => {
  const f = fixture();
  await expect(checkTestFixtures(f.root, { ...f.env, CATALY_TEST_OMP_ROOT: host })).rejects.toThrow(
    "absolute exact native OMP fixture",
  );
});

test("a wrong native version cannot pass the prerequisite check", async () => {
  const f = fixture();
  const host = join(f.root, "native");
  mkdirSync(host);
  writeFileSync(join(host, "package.json"), '{"version":"0.0.0"}\n');
  await expect(checkTestFixtures(f.root, { ...f.env, CATALY_TEST_OMP_ROOT: host })).rejects.toThrow(
    `must be ${nativeFixture.dependencies["@oh-my-pi/pi-coding-agent"]}`,
  );
});

test("same-version metadata outside the imported native host is still refused", async () => {
  const f = fixture();
  const host = join(f.root, "foreign-native");
  mkdirSync(host);
  writeFileSync(
    join(host, "package.json"),
    JSON.stringify({ version: nativeFixture.dependencies["@oh-my-pi/pi-coding-agent"] }),
  );
  for (const path of [
    "src/extensibility/extensions/runner.ts",
    "src/extensibility/extensions/loader.ts",
    "src/config/settings.ts",
    "src/session/session-manager.ts",
    "src/utils/event-bus.ts",
  ]) {
    mkdirSync(dirname(join(host, path)), { recursive: true });
    writeFileSync(join(host, path), "export {};\n");
  }
  await expect(checkTestFixtures(f.root, { ...f.env, CATALY_TEST_OMP_ROOT: host })).rejects.toThrow(
    "outside CATALY_TEST_OMP_ROOT",
  );
});

test.each(["direct", "alias"])(
  "native executable evidence identifies the %s host and actual public features",
  async (kind) => {
    const f = fixture();
    const host = kind === "alias" ? join(f.root, "node_modules/@oh-my-pi/pi-coding-agent") : nativeHost;
    if (kind === "alias") {
      mkdirSync(dirname(host), { recursive: true });
      symlinkSync(nativeHost, host, "dir");
    }
    expect(await checkTestFixtures(f.root, { ...f.env, CATALY_TEST_OMP_ROOT: host })).toMatchObject({
      native: {
        root: realpathSync(nativeHost),
        entry: join(host, "dist/cli.js"),
        nativeVersion: nativeFixture.dependencies["@oh-my-pi/pi-coding-agent"],
        publicAPI: expect.arrayContaining(["importExtensionModule", "ExtensionRunner", "Settings.isolated"]),
      },
      cli: {
        realpath: realpathSync(process.execPath),
        entry: join(host, "dist/cli.js"),
        version: nativeFixture.dependencies["@oh-my-pi/pi-coding-agent"],
      },
    });
  },
);

test("a missing public native API fails with its exact resolved module and feature name", () => {
  const f = fixture();
  const code = String.raw`
    Bun.plugin({ name: "missing-native-api", setup(build) {
      build.onLoad({ filter: /[/\\]extensibility[/\\]extensions[/\\]loader\.ts$/ }, () => ({
        loader: "object", exports: { ExtensionRuntime: class {}, loadExtensionFromFactory() {} }
      }));
    }});
    const { checkTestFixtures } = await import(${JSON.stringify(join(source, "scripts/check-test-fixtures.ts"))});
    try { await checkTestFixtures(process.argv[1]); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const child = Bun.spawnSync([process.execPath, "-e", code, f.root], {
    env: { ...process.env, ...f.env },
    stdin: "ignore",
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("missing public native API importExtensionModule");
  expect(child.stderr.toString().replaceAll("\\", "/")).toContain(
    realpathSync(join(nativeHost, "src/extensibility/extensions/loader.ts")).replaceAll("\\", "/"),
  );
});

test("the real prerequisite CLI exits nonzero without a successful marker for missing prerequisites", () => {
  const child = Bun.spawnSync([process.execPath, join(source, "scripts/check-test-fixtures.ts")], {
    env: { ...process.env, CATALY_TEST_OMP_ROOT: "relative/native" },
    stdin: "ignore",
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("CI_FIXTURES_FAIL");
  expect(child.stdout.toString()).not.toContain("CI_FIXTURES_OK");
});
