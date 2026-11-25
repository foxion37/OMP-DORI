import { expect, test } from "bun:test";
import { MONITOR_ENTRY, recordedMonitors, recordedMonitorStates } from "../monitor-state.ts";

const entry = (data: unknown) => ({ type: "custom", customType: MONITOR_ENTRY, data });
const spec = { name: "ci", argv: ["true"], cwd: "/tmp", filter: ".", mode: "once" } as const;
const exit = { code: 0, signal: null, at: "2026-11-18T00:00:00.000Z" };

test("successful once completion is a backwards-compatible stop with retained terminal details", () => {
  const branch = [
    entry({ op: "start", ...spec, id: "run-1" }),
    entry({ op: "stop", name: spec.name, id: "run-1", exit }),
  ];
  expect(recordedMonitors(branch).size).toBe(0);
  expect(recordedMonitorStates(branch).get("ci")).toEqual({ spec, id: "run-1", exit, completed: true });
  // An older start/stop-only extension sees the same durable stop, not an unknown new exit operation.
  expect(branch.at(-1)?.data).toMatchObject({ op: "stop", name: "ci" });
  expect(recordedMonitorStates([...branch, entry({ op: "stop", name: "ci" })]).size).toBe(0);
});

test("a late exit receipt cannot reopen a completed once start", () => {
  const branch = [
    entry({ op: "start", ...spec, id: "one" }),
    entry({ op: "stop", name: "ci", id: "one", exit }),
    entry({ op: "exit", name: "ci", id: "one", exit: { ...exit, code: 7 } }),
  ];
  expect(recordedMonitors(branch).size).toBe(0);
  expect(recordedMonitorStates(branch).get("ci")).toEqual({ spec, id: "one", exit, completed: true });
});

test("an exit from an older start cannot complete a same-named replacement", () => {
  const branch = [
    entry({ op: "start", ...spec, id: "old" }),
    entry({ op: "start", ...spec, id: "new" }),
    entry({ op: "stop", name: "ci", id: "old", exit }),
  ];
  expect(recordedMonitors(branch).get("ci")).toEqual(spec);
  expect(recordedMonitorStates(branch).get("ci")).toEqual({ spec, id: "new", completed: false });
});

test("persistent starts without a mode keep their intent and gain a last-exit observation", () => {
  const { mode: _mode, ...persistent } = spec;
  const branch = [entry({ op: "start", ...persistent }), entry({ op: "exit", name: "ci", exit })];
  expect(recordedMonitors(branch).get("ci")).toEqual(persistent);
  expect(recordedMonitorStates(branch).get("ci")).toEqual({ spec: persistent, exit, completed: false });
});

test.each([
  { code: 7, signal: null, at: exit.at },
  { code: null, signal: "SIGTERM", at: exit.at },
  { ...exit, error: "output storage failed" },
  { ...exit, at: "invalid" },
])("invalid or unsuccessful completion never clears desired intent: %j", (outcome) => {
  const branch = [
    entry({ op: "start", ...spec, id: "one" }),
    entry({ op: "stop", name: "ci", id: "one", exit: outcome }),
  ];
  expect(recordedMonitors(branch).get("ci")).toEqual(spec);
  expect(recordedMonitorStates(branch).get("ci")?.completed).toBe(false);
});

test("persistent jobs cannot be silently completed by a once-only receipt", () => {
  const { mode: _mode, ...persistent } = spec;
  const branch = [entry({ op: "start", ...persistent, id: "one" }), entry({ op: "stop", name: "ci", id: "one", exit })];
  expect(recordedMonitors(branch).get("ci")).toEqual(persistent);
});

test("an unknown future mode fails closed rather than becoming persistent", () => {
  expect(() => recordedMonitors([entry({ op: "start", ...spec, mode: "future" })])).toThrow("unsupported monitor mode");
});
