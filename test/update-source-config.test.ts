import { expect, test } from "bun:test";
import { chmodSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  loadSourceUpdateConfig,
  parseSourceUpdateConfig,
  sourceRequiredCi,
} from "../src/update/source-update-config.ts";
import { sourceFixture } from "./update-source-setup.ts";

const checks = ["check"];
test("source configuration opts into daily, thirty-minute, draft-aware updates without creating deployment state", () => {
  const f = sourceFixture();
  expect(f.config.repository).toBe("vntrevx/Cataly");
  expect(f.config.intervalSeconds).toBe(86_400);
  expect(f.config.ownerQuietMs).toBe(1_800_000);
  expect(f.config.activityMaxAgeMs).toBe(120_000);
  expect(f.config.requiredCi).toEqual(checks);
  expect(Object.keys(f.config.deployment)).not.toContain("nativeStopMode");
  expect(existsSync(f.config.deployment.releaseRoot)).toBe(false);
});

const invalid: Record<string, unknown>[] = [
  { ownerQuietMinutes: 29 },
  { ownerQuietMinutes: 30.5 },
  { intervalSeconds: 0 },
  { activityMaxAgeSeconds: 301 },
  { activityFiles: [] },
  { activityFiles: ["outside.json"] },
  { requiredCi: ["extra-job"] },
  { requiredCi: [...checks, "check"] },
  { repository: "https://github.com/vntrevx/Cataly" },
  { version: 2 },
  { surprise: true },
];
for (const change of invalid)
  test(`source configuration rejects unsafe settings ${JSON.stringify(change)}`, () => {
    const f = sourceFixture();
    expect(() => parseSourceUpdateConfig({ ...f.settings, ...change }, f.path)).toThrow();
  });

test("source configuration refuses an unknown deployment setting and cannot count duplicate receivers", () => {
  const f = sourceFixture();
  expect(() =>
    parseSourceUpdateConfig({ ...f.settings, deployment: { ...f.settings.deployment, nativeStopMode: "ui" } }, f.path),
  ).toThrow("unknown setting");
  expect(() =>
    parseSourceUpdateConfig(
      { ...f.settings, activityFiles: [...f.settings.activityFiles, ...f.settings.activityFiles] },
      f.path,
    ),
  ).toThrow("distinct paths");
});

test.skipIf(process.platform === "win32")("source configuration rejects unprotected and linked opt-in files", () => {
  const f = sourceFixture();
  expect(loadSourceUpdateConfig(f.path)).toEqual(f.config);
  chmodSync(f.path, 0o666);
  expect(() => loadSourceUpdateConfig(f.path)).toThrow("owned protected");
  chmodSync(f.path, 0o600);
  const link = join(f.root, "linked-config.json");
  symlinkSync(f.path, link);
  expect(() => loadSourceUpdateConfig(link)).toThrow("owned protected");
});

test("the source gate accepts additional explicitly required CI jobs", () => {
  expect(sourceRequiredCi([...checks, "extra-job"])).toEqual([...checks, "extra-job"]);
});

test.skipIf(process.platform !== "win32")("source configuration cannot use an unverified Windows ACL", () => {
  const f = sourceFixture();
  expect(() => loadSourceUpdateConfig(f.path)).toThrow("requires verified POSIX configuration file ownership");
  expect(existsSync(f.config.deployment.releaseRoot)).toBe(false);
});
