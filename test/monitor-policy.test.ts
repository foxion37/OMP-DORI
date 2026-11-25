import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMonitorManifests } from "../skills/cataly-mode/scripts/src/boot-monitors.ts";
import { readMonitorSet, sameMonitorSpecs } from "../src/update/deployment-monitors.ts";
import type { MonitorSpec } from "../src/update/deployment-types.ts";
import { monitorPolicy } from "../src/update/monitor-policy.ts";
import { MONITOR_ENTRY, recordedMonitors, recordedMonitorStates } from "../extension/monitor-state.ts";

const spec: MonitorSpec = {
  name: "daemon",
  argv: [process.execPath, "-e", ""],
  filter: ".",
  cwd: "/tmp",
  mode: "daemon",
  restart: { max: 2, backoffSec: 1 },
};
const entry = (data: unknown) => ({ type: "custom", customType: MONITOR_ENTRY, data });
const exit = (restartAttempt: number, exhausted = false) => ({
  code: 7,
  signal: null,
  at: "2026-11-19T00:00:00.000Z",
  restartAttempt,
  exhausted,
});

test("legacy shape stays unchanged and daemon defaults are canonical", () => {
  expect(monitorPolicy({})).toEqual({});
  expect(monitorPolicy({ mode: "persistent" })).toEqual({});
  expect(monitorPolicy({ mode: "once" })).toEqual({ mode: "once" });
  expect(monitorPolicy({ mode: "daemon" })).toEqual({ mode: "daemon", restart: { max: 5, backoffSec: 10 } });
  expect(
    monitorPolicy({ mode: "daemon", restart: { max: 0, backoffSec: 0.001 }, silentAfterMin: 0.001 }),
  ).toMatchObject({ restart: { max: 0 }, silentAfterMin: 0.001 });
});

test.each([
  { mode: "unknown" },
  { restart: { max: 1, backoffSec: 1 } },
  { mode: "once", restart: {} },
  { mode: "daemon", restart: null },
  { mode: "daemon", restart: {} },
  ...[-1, 0.5, 101, NaN, Infinity].map((max) => ({ mode: "daemon", restart: { max, backoffSec: 1 } })),
  ...[0, -1, NaN, Infinity, 2_147_484].map((backoffSec) => ({ mode: "daemon", restart: { max: 1, backoffSec } })),
  { mode: "daemon", restart: { max: 1, backoffSec: 1, typo: true } },
  ...[0, -1, NaN, Infinity, 36_000, "1"].map((silentAfterMin) => ({ silentAfterMin })),
])("invalid monitor policy is rejected by canonical parsing and journal replay: %j", (policy) => {
  expect(() => monitorPolicy(policy)).toThrow();
  expect(() =>
    recordedMonitorStates([entry({ op: "start", ...spec, restart: undefined, mode: undefined, ...policy })]),
  ).toThrow();
});

test("health equality includes every behavioral policy but ignores live retry state", () => {
  expect(sameMonitorSpecs([spec], [{ ...spec }])).toBe(true);
  expect(
    sameMonitorSpecs(
      [{ name: spec.name, argv: spec.argv, filter: spec.filter, cwd: spec.cwd, mode: "daemon" }],
      [{ ...spec, restart: { max: 5, backoffSec: 10 } }],
    ),
  ).toBe(true);
  expect(sameMonitorSpecs([spec], [{ ...spec, restart: { max: 3, backoffSec: 1 } }])).toBe(false);
  expect(sameMonitorSpecs([spec], [{ ...spec, restart: { max: 2, backoffSec: 2 } }])).toBe(false);
  expect(sameMonitorSpecs([spec], [{ ...spec, silentAfterMin: 1 }])).toBe(false);
});

test("retry counters cannot roll back and exhaustion cannot stop another generation", () => {
  const start = entry({ op: "start", ...spec, id: "first" });
  const progress = entry({ op: "exit", name: spec.name, id: "first", exit: exit(2) });
  const rollback = entry({ op: "exit", name: spec.name, id: "first", exit: exit(1) });
  expect(recordedMonitorStates([start, progress, rollback]).get(spec.name)?.exit?.restartAttempt).toBe(2);
  const exhausted = entry({ op: "stop", name: spec.name, id: "first", exit: exit(2, true) });
  expect(recordedMonitors([start, progress, exhausted]).size).toBe(0);
  expect(
    recordedMonitorStates([start, entry({ op: "stop", name: spec.name, id: "first", exit: exit(1, true) })]).get(
      spec.name,
    )?.completed,
  ).toBe(false);
  expect(recordedMonitors([start, entry({ op: "start", ...spec, id: "second" }), exhausted]).size).toBe(1);
});

// The managed deployment reader enforces POSIX ownership and mode bits; on Windows trusted reads always hold.
const posix = test.skipIf(process.platform === "win32");
posix.each([1, 2, 3])("new monitor policies require metadata version three, not %s", (version) => {
  const root = mkdtempSync(join(tmpdir(), "cataly-daemon-policy-"));
  const path = join(root, "owner.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        version,
        sessionId: "owner",
        monitors: [spec],
        intake: { path: join(root, "heartbeat"), monitor: spec.name, maxAgeMs: 1000 },
      }),
      { mode: 0o600 },
    );
    const boot = readMonitorManifests(root);
    if (version === 3) {
      expect(readMonitorSet(path, "owner", true)).toMatchObject({ version: 3, monitors: [spec] });
      expect(boot.errors).toEqual([]);
    } else {
      expect(() => readMonitorSet(path, "owner", true)).toThrow("invalid specification");
      expect(boot.errors).toEqual([path]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
