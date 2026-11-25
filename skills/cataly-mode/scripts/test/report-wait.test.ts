import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseEvent } from "../src/report-events.ts";
import { SESSION, T0, waitFixture } from "./wait-fixture.ts";

let f: Awaited<ReturnType<typeof waitFixture>>;
beforeEach(async () => {
  f = await waitFixture();
});
afterEach(() => f.done());

test("the report handler persists and prints the attested session/job identity; the same wait keeps its since", async () => {
  const first = await f.report("job:bg_1");
  expect(first.record?.wait).toMatchObject({
    target: {
      kind: "job",
      id: "bg_1",
      sessionId: SESSION,
      sessionStartedAt: new Date(T0).toISOString(),
      jobStartTime: T0,
    },
    startedAt: T0 + 1_000,
    lastObservedState: "running",
  });
  expect(first.lines[0]).toContain("WAIT job:bg_1");
  expect(first.lines[0]).toContain(SESSION);
  f.advance(60_000);
  f.observe({ running: [{ id: "bg_1", startTime: T0 }], recent: [] });
  const again = await f.report("job:bg_1");
  expect(again.record?.wait?.startedAt).toBe(first.record?.wait?.startedAt);
  expect(again.record?.wait?.observedAt).toBe(f.clock.at);
  f.observe({ running: [{ id: "bg_1", startTime: T0 + 50_000 }], recent: [] });
  expect((await f.report("job:bg_1")).record?.wait?.startedAt).toBe(f.clock.at);
});

test.each(["completed", "failed", "cancelled"] as const)(
  "a %s job cannot be reported waiting and does not append",
  async (status) => {
    await f.report("job:bg_1");
    const before = readFileSync(f.reports.path(f.lane.key), "utf8");
    f.observe({ running: [], recent: [{ id: "bg_1", startTime: T0, status }] });
    await expect(f.report("job:bg_1")).rejects.toThrow("not observed running");
    expect(readFileSync(f.reports.path(f.lane.key), "utf8")).toBe(before);
  },
);

test("native unknown, a foreign approval and a non-blocker selection are refused", async () => {
  f.observe(null, [{ sessionId: "other", toolCallId: "call-1", toolName: "bash" }]);
  await expect(f.report("job:bg_1")).rejects.toThrow("not observed running");
  await expect(f.report("approval:call-1")).rejects.toThrow("not observed pending");
  await expect(f.report("job:bg_1", "milestone")).rejects.toThrow("needs --kind blocker");
  expect(f.reports.read(f.lane.key)).toBeNull();
  f.observe(null, [{ sessionId: SESSION, toolCallId: "call-1", toolName: "bash" }]);
  expect((await f.report("approval:call-1")).record?.wait?.target).toMatchObject({
    kind: "approval",
    id: "call-1",
    sessionId: SESSION,
  });
});

test("a typed dependency stays unverified without consulting a native job", async () => {
  f.world.calls = [];
  const result = await f.report("waiting for upstream review");
  expect(result.record?.wait).toMatchObject({
    target: { kind: "label", text: "waiting for upstream review" },
    lastObservedState: "unverified",
  });
  expect(result.lines[0]).toContain("unverified");
  expect(f.world.calls).toEqual([]);
});

test("a newer report arriving during the probe is never replaced by the older waiting report", async () => {
  f.control.onProbe = async () => {
    await f.reports.report(f.lane.key, "milestone", "new progress", f.clock.at);
  };
  await expect(f.report("job:bg_1")).rejects.toThrow("newer report");
  expect(f.reports.read(f.lane.key)?.lastReport?.text).toBe("new progress");
});

test("a paused lane arriving during the probe remains paused and gets no stale wait append", async () => {
  f.control.onProbe = async () => {
    await f.deps.registry.update(f.lane.key, (lane) => {
      if (!lane) throw new Error("lane missing");
      return { ...lane, status: "paused" };
    });
  };
  await expect(f.report("job:bg_1")).rejects.toThrow("lane state changed");
  expect((await f.deps.registry.read(f.lane.key))?.status).toBe("paused");
  expect(f.reports.read(f.lane.key)).toBeNull();
});

test("a progress report or a reopened incarnation starts a new waiting interval", async () => {
  await f.report("job:bg_1");
  f.advance(10_000);
  await f.reports.report(f.lane.key, "milestone", "working again", f.clock.at);
  expect((await f.report("job:bg_1")).record?.wait?.startedAt).toBe(f.clock.at);
  f.advance(10_000);
  await f.deps.registry.update(f.lane.key, (lane) => {
    if (!lane) throw new Error("lane missing");
    return { ...lane, openedAt: new Date(f.clock.at).toISOString() };
  });
  expect((await f.report("job:bg_1")).record?.wait?.startedAt).toBe(f.clock.at);
});

test("malformed proof metadata is dropped without dropping its blocker", async () => {
  const record = (await f.report("job:bg_1")).record;
  const decoded = parseEvent(
    JSON.stringify({ ...record, wait: { target: { kind: "job", id: "forged" } } }),
    f.lane.key,
  );
  expect(decoded).toMatchObject({ type: "report", kind: "blocker" });
  expect(decoded).not.toHaveProperty("wait");
});

test("a native close intent arriving during the probe fences the wait append", async () => {
  f.control.onProbe = async () => {
    await f.deps.registry.update(
      f.lane.key,
      (lane) =>
        lane && {
          ...lane,
          nativeCloseIntent: {
            ref: { runtime: "tern", id: f.lane.sessionRef!.id },
            session: SESSION,
            note: "close pending",
            checks: [],
            settlingClaim: false,
          },
        },
    );
  };
  await expect(f.report("job:bg_1")).rejects.toThrow("lane state changed");
  expect(f.reports.read(f.lane.key)).toBeNull();
  expect((await f.deps.registry.read(f.lane.key))?.nativeCloseIntent).toBeDefined();
});
