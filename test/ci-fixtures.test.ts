import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkTestFixtures } from "../scripts/check-test-fixtures.ts";

const source = resolve(import.meta.dir, "..");
const nativeHost = join(source, "test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dori-ci-fixtures-"));
  roots.push(root);
  const ulw = join(root, "ref/omp-ulw/index.ts");
  mkdirSync(dirname(ulw), { recursive: true });
  writeFileSync(ulw, 'throw new Error("fixture source was executed");\n');
  const compat = join(root, "compat.ts");
  writeFileSync(compat, 'throw new Error("fixture source was executed");\n');
  return {
    root,
    ulw,
    compat,
    env: { DORI_TEST_OMP_ROOT: nativeHost, DORI_TEST_COMPAT_ULW_ENTRY: compat },
  };
}

test("the prerequisite check accepts files and the actual exact native host without executing fixture code", async () => {
  const f = fixture();
  const before = readFileSync(f.ulw, "utf8");
  await checkTestFixtures(f.root, f.env);
  expect(readFileSync(f.ulw, "utf8")).toBe(before);
  expect(readFileSync(f.compat, "utf8")).toBe('throw new Error("fixture source was executed");\n');
});

test.each(["missing-ulw", "directory-ulw", "missing-compat", "relative-compat", "directory-compat"])(
  "%s cannot become a successful full gate with skipped fixture tests",
  async (kind) => {
    const f = fixture();
    if (kind === "missing-ulw" || kind === "directory-ulw") {
      rmSync(f.ulw);
      if (kind === "directory-ulw") mkdirSync(f.ulw);
    } else if (kind === "relative-compat") {
      f.env.DORI_TEST_COMPAT_ULW_ENTRY = "compat.ts";
    } else {
      rmSync(f.compat);
      if (kind === "directory-compat") mkdirSync(f.compat);
    }
    await expect(checkTestFixtures(f.root, f.env)).rejects.toThrow("existing absolute fixture file");
  },
);

test.each([undefined, "relative/native"])("an absent or relative native host is refused: %j", async (host) => {
  const f = fixture();
  await expect(checkTestFixtures(f.root, { ...f.env, DORI_TEST_OMP_ROOT: host })).rejects.toThrow(
    "absolute exact native OMP fixture",
  );
});

test("a wrong native version cannot pass the prerequisite check", async () => {
  const f = fixture();
  const host = join(f.root, "native");
  mkdirSync(host);
  writeFileSync(join(host, "package.json"), '{"version":"0.0.0"}\n');
  await expect(checkTestFixtures(f.root, { ...f.env, DORI_TEST_OMP_ROOT: host })).rejects.toThrow("must be 18.20.0");
});

test("same-version metadata outside the imported native host is still refused", async () => {
  const f = fixture();
  const host = join(f.root, "foreign-native");
  mkdirSync(host);
  writeFileSync(join(host, "package.json"), '{"version":"18.20.0"}\n');
  for (const path of [
    "src/extensibility/extensions/runner.ts",
    "src/extensibility/extensions/loader.ts",
    "src/config/settings.ts",
  ]) {
    mkdirSync(dirname(join(host, path)), { recursive: true });
    writeFileSync(join(host, path), "export {};\n");
  }
  await expect(checkTestFixtures(f.root, { ...f.env, DORI_TEST_OMP_ROOT: host })).rejects.toThrow(
    "outside DORI_TEST_OMP_ROOT",
  );
});

test("the real prerequisite CLI exits nonzero without a successful marker for missing prerequisites", () => {
  const child = Bun.spawnSync([process.execPath, join(source, "scripts/check-test-fixtures.ts")], {
    env: { ...process.env, DORI_TEST_COMPAT_ULW_ENTRY: "relative.ts" },
    stdin: "ignore",
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("CI_FIXTURES_FAIL");
  expect(child.stdout.toString()).not.toContain("CI_FIXTURES_OK");
});
