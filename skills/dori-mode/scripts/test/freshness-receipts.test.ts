import { afterEach, beforeEach, expect, test } from "bun:test";
import { freshnessTick } from "../src/freshness.ts";
import { footer } from "../src/launch-footer.ts";
import { parkLane } from "../src/park.ts";
import type { Lane } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import { Reports, reportId, reportLine } from "../src/reports.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, type TestState, withState } from "./fakes.ts";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const lane: Lane = {
  key: "receipt-lane",
  title: "receipt",
  thread: "discord:123",
  pane: "w:p7",
  brief: "/b",
  done: "file /done",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
};
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("a kind filter without a hook emits one notice for each exact unrelayed report", async () => {
  const world = newWorld();
  world.screen = "Working (1m)";
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, { freshness: { autoPostKinds: [] } });
  await deps.registry.write(lane);
  const reports = new Reports(state.dir);
  reports.report(lane.key, "blocker", "same detail", T0, undefined, "first summary");
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["unrelayed"]);
  expect(await freshnessTick(deps, state.dir)).toEqual([]);
  reports.report(lane.key, "blocker", "same detail", T0, undefined, "new summary");
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["unrelayed"]);
  expect(await freshnessTick(deps, state.dir)).toEqual([]);
  reports.report(lane.key, "blocker", "same detail", T0 + MIN, undefined, "new summary");
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["unrelayed"]);
});

test("default policy does not repost an identical report just because its timestamp changed", async () => {
  const world = newWorld();
  world.screen = "Working (1m)";
  const clock = fakeClock(T0 + 30 * MIN);
  const deps = depsFor(world, clock, state.dir, { hooks: { threadReply: ["notify", "{text}"] } });
  await deps.registry.write(lane);
  const reports = new Reports(state.dir);
  reports.report(lane.key, "milestone", "tests green", T0);
  expect((await freshnessTick(deps, state.dir)).some((a) => a.kind === "posted")).toBe(true);
  clock.at += 30 * MIN;
  reports.report(lane.key, "milestone", "tests green", clock.at);
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["stale-report"]);
  reports.report(lane.key, "milestone", "tests green", clock.at + 1);
  expect(await freshnessTick(deps, state.dir)).toEqual([]);
  expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
});

test("an acknowledgement arriving during the hook cannot be overwritten by the older post", async () => {
  const world = newWorld();
  world.screen = "Working (1m)";
  const clock = fakeClock(T0 + 30 * MIN);
  const deps = depsFor(world, clock, state.dir, {
    freshness: { nudge: "idle-only" },
    hooks: { threadReply: ["notify"] },
  });
  await deps.registry.write(lane);
  const reports = new Reports(state.dir);
  reports.report(lane.key, "milestone", "first detail", T0);
  let relayed = "";
  await freshnessTick(
    {
      ...deps,
      run: async (argv, options) => {
        if (argv[0] === "notify") {
          const newer = reports.report(lane.key, "milestone", "second detail", clock.at, undefined, "Second summary");
          relayed = reportId(newer);
          await deps.registry.update(
            lane.key,
            (live) =>
              live && {
                ...live,
                lastPostedReport: reportLine(newer),
                lastPostedReportOwner: newer.owner,
                lastPostedReportId: relayed,
                lastRelayedAt: clock.at,
              },
          );
        }
        return deps.run(argv, options);
      },
    },
    state.dir,
  );
  expect(relayed).not.toBe("");
  expect((await deps.registry.read(lane.key))?.lastPostedReportId).toBe(relayed);
  clock.at += 30 * MIN;
  await freshnessTick(deps, state.dir);
  expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
});

test("a receipt changed since the tick snapshot is rechecked before calling the hook", async () => {
  const world = newWorld();
  world.screen = "Working (1m)";
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, {
    freshness: { nudge: "idle-only" },
    hooks: { threadReply: ["notify"] },
  });
  await deps.registry.write(lane);
  const report = new Reports(state.dir).report(lane.key, "milestone", "detail", T0);
  const read = deps.registry.read.bind(deps.registry);
  let changed = false;
  deps.registry.read = async (key) => {
    const snapshot = await read(key);
    if (!changed) {
      changed = true;
      await deps.registry.update(
        key,
        (live) =>
          live && {
            ...live,
            lastPostedReportId: reportId(report),
            lastPostedReport: reportLine(report),
            lastRelayedAt: T0 + 30 * MIN,
          },
      );
    }
    return snapshot;
  };
  await freshnessTick(deps, state.dir);
  expect(changed).toBe(true);
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
});

test("idle-only delivery failure alerts once without consuming the nudge", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "idle" }];
  agentIn(world, "w:p7");
  laneState(state.dir, "w:p7", { agentStatus: "idle" });
  const base = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, { freshness: { nudge: "idle-only" } });
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => {
      if (argv[0] === "herdr" && argv[2] === "list") return { code: 0, out: '{"result":{"panes":[]}}', err: "" };
      return base.run(argv);
    },
  };
  await deps.registry.write({ ...lane, reportProtocol: undefined });
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["nudge-failed"]);
  expect(await freshnessTick(deps, state.dir)).toEqual([]);
  expect((await deps.registry.read(lane.key))?.lastNudgeAt).toBeUndefined();
});

test("summary-only launch footer requests the owner field, while the default command stays unchanged", () => {
  expect(footer(lane, "", {}, "herdr", { postRaw: false })).toContain('--owner "$owner"');
  expect(footer(lane, "", {}, "herdr")).not.toContain('--owner "$owner"');
});

test("an adopted lane still reports a newly excluded report after it auto-posted a milestone", async () => {
  const world = newWorld();
  const clock = fakeClock(T0 + 30 * MIN);
  const deps = depsFor(world, clock, state.dir, {
    nudgeAfterMin: 1000,
    freshness: { autoPostKinds: ["milestone"] },
    hooks: { threadReply: ["notify", "{text}"] },
  });
  await deps.registry.write({ ...lane, reportProtocol: undefined });
  world.screen = `[REPORT] ${lane.key} | milestone | progress`;
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["pending-report"]);
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["posted"]);
  clock.at += 30 * MIN;
  world.screen = `[REPORT] ${lane.key} | blocker | needs lead`;
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["pending-report"]);
  world.screen = "Working (1m)";
  expect(await freshnessTick(deps, state.dir)).toEqual([]);
  world.screen = `[REPORT] ${lane.key} | blocker | needs lead`;
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["pending-report"]);
  expect((await freshnessTick(deps, state.dir)).map((a) => a.kind)).toEqual(["unrelayed"]);
  expect(await freshnessTick(deps, state.dir)).toEqual([]);
  expect(world.calls.filter(([command]) => command === "notify")).toHaveLength(1);
});

test("an old receipt cannot suppress identical content after the lane is parked and reopened", async () => {
  const f = await lifecycleFixture();
  try {
    const reports = new Reports(f.state.dir);
    const now = f.deps.clock.now();
    const prior = reports.report(f.lane.key, "milestone", "same detail", now, undefined, "Same summary");
    const original = {
      ...f.lane,
      thread: "discord:123",
      reportProtocol: "jsonl-v1" as const,
      lastPostedReport: reportLine(prior),
      lastPostedReportId: reportId(prior),
      lastPostedReportOwner: prior.owner,
      lastRelayedAt: now,
    };
    await f.deps.registry.write(original);
    const parked = await parkLane(f.deps, original, "wait");
    expect(parked.code).toBe(0);
    const reopened = await reopenLane(f.deps, parked.lane);
    expect(reopened.code).toBe(0);
    const epoch = reopened.lane.lifecycleEpoch;
    if (!epoch) throw new Error("expected the reopened lane generation");
    const fresh = reports.report(f.lane.key, prior.kind, prior.text, Date.parse(prior.at), epoch, prior.owner);
    expect(reportId(fresh)).not.toBe(reportId(prior));
    f.world.screen = "Working (1m)";
    const deps = {
      ...f.deps,
      clock: fakeClock(now + 30 * MIN),
      config: { ...f.deps.config, nudgeAfterMin: 1000, hooks: { threadReply: ["notify", "{text}"] } },
    };
    const acts = await freshnessTick(deps, f.state.dir);
    expect(acts.map((a) => a.kind)).toEqual(["posted"]);
    expect((await deps.registry.read(f.lane.key))?.lastPostedReportId).toBe(reportId(fresh));
  } finally {
    f.state.done();
  }
});
