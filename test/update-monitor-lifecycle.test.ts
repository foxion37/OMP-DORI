import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMonitorManifests } from "../skills/cataly-mode/scripts/src/boot-monitors.ts";
import { readMonitorSet, sameMonitorSpecs } from "../src/update/deployment-monitors.ts";
import { DeploymentHeld } from "../src/update/deployment-process.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const spec = { name: "inbound", argv: ["sleep", "30"], cwd: tmpdir(), filter: "." };
// The managed deployment reader enforces POSIX ownership and mode bits; boot is portable.
const posix = test.skipIf(process.platform === "win32");
const fixture = (version: number, mode?: string) => {
  const root = mkdtempSync(join(tmpdir(), "cataly-monitor-lifecycle-"));
  roots.push(root);
  const omp = join(root, "monitors");
  mkdirSync(omp, { mode: 0o700 });
  const path = join(omp, "session.json");
  writeFileSync(
    path,
    JSON.stringify({
      version,
      sessionId: "session",
      monitors: [{ ...spec, ...(mode === undefined ? {} : { mode }) }],
      intake: { path: join(root, "heartbeat"), monitor: spec.name, maxAgeMs: 1000 },
    }),
    { mode: 0o600 },
  );
  return { root, omp, path };
};

for (const version of [1, 2]) {
  posix(`managed replacement does not normalize once work into persistent work in version ${version}`, () => {
    const { path } = fixture(version, "once");
    expect(() => readMonitorSet(path, "session", true)).toThrow('waits for once monitor "inbound"');
    expect(() => readMonitorSet(path, "session", true)).toThrow(DeploymentHeld);
  });
}

for (const mode of [undefined, "persistent"]) {
  posix(`default persistent monitor manifests remain compatible: ${mode}`, () => {
    const { path } = fixture(1, mode);
    expect(readMonitorSet(path, "session", true).monitors).toEqual([spec]);
  });
}

test.skipIf(process.platform !== "win32")(
  "boot reads the Windows manifest without treating it as POSIX-trusted",
  () => {
    const { omp, path } = fixture(2, "once");
    expect(readMonitorManifests(omp).manifests).toHaveLength(1);
    expect(() => readMonitorSet(path, "session", true)).toThrow(/monitor metadata ownership differs|must be private/);
  },
);

test("mode is part of monitor identity while equivalent regex spelling is not", () => {
  expect(sameMonitorSpecs([spec], [{ ...spec, filter: new RegExp(spec.filter).source }])).toBe(true);
  expect(sameMonitorSpecs([spec], [{ ...spec, mode: "once" }])).toBe(false);
});

test("boot reads lifecycle metadata", () => {
  const { omp, path } = fixture(2, "once");
  expect(readMonitorManifests(omp)).toMatchObject({
    manifests: [{ path, data: { version: 2, monitors: [{ ...spec, mode: "once" }] } }],
    errors: [],
  });
});

test.each(["future", "daemon"])("unsupported modes are rejected rather than ignored: %s", (mode) => {
  const { omp, path } = fixture(2, mode);
  if (process.platform !== "win32")
    expect(() => readMonitorSet(path, "session", true)).toThrow("invalid specification");
  expect(readMonitorManifests(omp)).toEqual({ manifests: [], errors: [path] });
});

test("a once manifest must carry the version fence even for read-only boot", () => {
  const { omp, path } = fixture(1, "once");
  expect(readMonitorManifests(omp)).toEqual({ manifests: [], errors: [path] });
});
