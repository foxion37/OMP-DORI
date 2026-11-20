import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { parkLane } from "../src/park.ts";
import { type Lane, Registry, sessionOf, statusOf } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import { Reports } from "../src/reports.ts";
import type { Clock } from "../src/run.ts";
import { laneStatus } from "../src/status.ts";
import { Worklog } from "../src/worklog.ts";
import { fakeClock } from "./fakes.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

const minute = 60_000;
const wallMinutes = 30;
const ceiling = `wallMinutes ceiling reached (${wallMinutes})`;
const usageCommand = "fixture-usage";
const usage = { code: 0, out: '{"tokens":1,"costUsd":0}', err: "" };

let f: LifecycleFixture;
let lane: Lane;
let clock: Clock & { at: number };
let deps: FlowDeps;
let reports: Reports;

beforeEach(async () => {
  f = await lifecycleFixture();
  clock = fakeClock(f.deps.clock.now());
  lane = {
    ...f.lane,
    session: f.session,
    sessionFile: f.file,
    reportProtocol: "jsonl-v1",
  };
  deps = {
    ...f.deps,
    clock,
    config: {
      ...f.deps.config,
      supervision: { usageArgv: [usageCommand], defaults: { wallMinutes } },
    },
    run: (argv, options) => (argv[0] === usageCommand ? Promise.resolve(usage) : f.deps.run(argv, options)),
  };
  await deps.registry.write(lane);
  reports = new Reports(f.state.dir);
});

afterEach(() => f.state.done());

const journal = () => Bun.file(reports.path(lane.key)).text();
const status = async () => (await laneStatus(deps, lane.key)).lanes[0];
const boot = () =>
  bootCheck({ ...deps, reports, worklog: new Worklog(f.state.dir), slack: async () => null, monitorDirs: [] });

const park = async () => {
  const parked = await parkLane(deps, lane, "waiting for operator");
  expect(parked.code).toBe(0);
  expect(statusOf(parked.lane)).toBe("closed");
  return parked.lane;
};

test("Boot and status ignore old Done after a registry reopen without a durable marker", async () => {
  const oldDone = reports.report(lane.key, "done", "previous generation finished", clock.now());
  const oldJournal = await journal();
  const dir = join(f.state.dir, "monitors");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "owner.json"),
    JSON.stringify({
      version: 1,
      sessionId: "owner",
      monitors: [{ name: "lane-watch", argv: ["dori", "watch", lane.key], cwd: deps.config.defaultCwd }],
    }),
  );
  const before = await boot();
  expect(before.lines.some((line) => line.startsWith(`REPORT ${lane.key} kind=done `))).toBe(true);
  expect(before.lines.some((line) => line.startsWith(`CLEANUP ${lane.key} `))).toBe(true);
  expect((await status())?.progress?.lastReport).toEqual(oldDone);

  const parked = await park();
  clock.at += minute;
  const interruption = new Error("interrupted after reopen registry commit");
  const registry = new (class extends Registry {
    override async transition(...args: Parameters<Registry["transition"]>): Promise<Lane | null> {
      const saved = await super.transition(...args);
      if (saved && statusOf(saved) === "paused" && saved.openedAt !== parked.openedAt) throw interruption;
      return saved;
    }
  })(f.state.dir);
  await reopenLane({ ...deps, registry }, parked).catch((error: unknown) => {
    if (error !== interruption) throw error;
  });
  const current = await deps.registry.read(lane.key);
  if (!current) throw new Error("reopened lane was not persisted");
  const ref = sessionOf(current);
  expect(current.openedAt).toBe(new Date(clock.now()).toISOString());
  expect(current.openedAt).not.toBe(parked.openedAt);
  expect(statusOf(current)).toBe("paused");
  expect(ref?.id).not.toBe(sessionOf(parked)?.id);
  expect(f.world.panes.some((pane) => pane.pane_id === ref?.id)).toBe(true);
  expect(await journal()).toBe(oldJournal);
  // The new pane disappears before the operator checks Boot. Only the old journal survives.
  f.world.panes = f.world.panes.filter((pane) => pane.pane_id !== ref?.id);

  const after = await boot();
  const projected = await status();
  expect({
    vanished: after.lines.some((line) => line.startsWith(`VANISHED ${lane.key} pane=${ref?.id} status=paused;`)),
    cleanup: after.lines.some((line) => line.startsWith(`CLEANUP ${lane.key} `)),
    noReport: after.lines.some((line) => line.startsWith(`NO-REPORT ${lane.key} `)),
    statusReport: projected?.progress?.lastReport ?? null,
    statusProgress: projected?.progress?.state ?? "running",
  }).toEqual({ vanished: true, cleanup: false, noReport: true, statusReport: null, statusProgress: "running" });
  expect(projected).toMatchObject({ status: "paused", openedAt: current.openedAt });
  expect(await journal()).toBe(oldJournal);
});

test("freshness durably reports a genuine wall ceiling in the same generation", async () => {
  reports.report(lane.key, "milestone", "old generation is still working", clock.now());
  const acts = await freshnessTick(deps, f.state.dir);
  expect(acts).toContainEqual({ kind: "blocked", lane: lane.key, detail: ceiling });
  expect((await status())?.progress).toMatchObject({
    state: "blocked",
    lastReport: { kind: "blocker", text: ceiling },
  });
  expect(await journal()).toContain("old generation is still working");
});

test("a freshness sweep held in usage cannot block or overwrite a reopened generation", async () => {
  reports.report(lane.key, "milestone", "old generation is still working", clock.now());
  const oldJournal = await journal();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const stale = freshnessTick(
    {
      ...deps,
      run: async (argv, options) => {
        if (argv[0] !== usageCommand) return deps.run(argv, options);
        entered.resolve();
        await release.promise;
        return usage;
      },
    },
    f.state.dir,
  );
  try {
    await Promise.race([
      entered.promise,
      stale.then(() => {
        throw new Error("the old sweep completed without reaching the usage process");
      }),
    ]);
    clock.at += minute;
    const parked = await park();
    const reopened = await reopenLane(deps, parked);
    expect(reopened.code).toBe(0);
    expect(reopened.lane.openedAt).toBe(new Date(clock.now()).toISOString());
    expect(reopened.lane.openedAt).not.toBe(lane.openedAt);
    expect(sessionOf(reopened.lane)?.id).not.toBe(sessionOf(lane)?.id);
    expect(statusOf(reopened.lane)).toBe("working");

    clock.at += minute;
    const currentReport = {
      type: "report" as const,
      key: lane.key,
      kind: "milestone" as const,
      text: "new generation made progress",
      at: new Date(clock.now()).toISOString(),
      ...(reopened.lane.lifecycleEpoch ? { generation: reopened.lane.lifecycleEpoch } : {}),
    };
    reports.append(currentReport);
    expect(await freshnessTick(deps, f.state.dir)).toEqual([]);
    const observation = Bun.file(join(dirname(reports.path(lane.key)), "supervision.json"));
    const currentObservation = await observation.text();
    const currentJournal = await journal();
    const currentLane = await deps.registry.read(lane.key);
    expect(currentJournal.startsWith(oldJournal)).toBe(true);
    expect(JSON.parse(currentObservation)).toMatchObject({ openedAt: reopened.lane.openedAt });

    release.resolve();
    const acts = await stale;
    expect({
      acts,
      sameJournal: (await journal()) === currentJournal,
      sameObservation: (await observation.text()) === currentObservation,
      progress: (await status())?.progress?.lastReport,
    }).toEqual({ acts: [], sameJournal: true, sameObservation: true, progress: currentReport });
    expect(await deps.registry.read(lane.key)).toEqual(currentLane);
  } finally {
    release.resolve();
    await stale;
  }
});
