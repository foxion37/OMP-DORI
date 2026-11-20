import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import { Decisions } from "../src/decisions.ts";
import { paneStatePath } from "../src/lane-state.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { runtimesOf } from "../src/run.ts";
import { laneEta, laneStatus } from "../src/status.ts";
import { renderBoard, renderStatus } from "../src/status-render.ts";
import { withDiscordCli } from "./discord-fakes.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState } from "./fakes.ts";

const now = Date.parse("2026-01-01T13:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: ReturnType<typeof newWorld>;
const lane: Lane = {
  key: "status-demo",
  title: "Status",
  thread: "discord:40",
  pane: "w:p7",
  session: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf",
  openedAt: "2026-01-01T12:00:00.000Z",
  brief: "/brief",
  done: "file /done",
  reportProtocol: "jsonl-v1",
};
const deps = () => depsFor(world, fakeClock(now), state.dir, { sessionsDir: join(state.dir, "sessions-root") });
const contents = () =>
  readdirSync(state.dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => [join(f.parentPath, f.name), readFileSync(join(f.parentPath, f.name), "utf8")])
    .sort();

beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "working" }];
  agentIn(world, "w:p7");
  laneState(state.dir, "w:p7", { agentStatus: "working" });
  await deps().registry.write(lane);
});
afterEach(() => state.done());

test("status joins live identity, journals, decisions and monitor metadata without writing or sending", async () => {
  new Reports(state.dir).report(lane.key, "question", "Which option?", now - 1000);
  new Checkpoints(state.dir).write(
    lane.key,
    { step: "first", result: "tested", evidence: ["/report"], remoteEffects: [] },
    now - 2000,
  );
  new Decisions(state.dir).ask({ question: "Choose", source: "owner message", lane: lane.key }, now);
  mkdirSync(join(state.dir, "monitors"));
  writeFileSync(
    join(state.dir, "monitors", "lead.json"),
    JSON.stringify({
      version: 1,
      sessionId: "lead",
      monitors: [{ name: "watch", argv: ["dori", "watch"], cwd: "/repo", suspended: true }],
    }),
  );
  const before = contents();
  const snapshot = await laneStatus(deps());
  expect(snapshot.lanes[0]?.runtime).toMatchObject({ agentStatus: "working", goal: { status: "active" } });
  expect(snapshot.lanes[0]?.progress?.state).toBe("blocked");
  expect(snapshot.lanes[0]?.checkpoint?.step).toBe("first");
  expect(snapshot.decisions).toBe(1);
  expect(snapshot.monitors).toEqual({ recorded: 1, suspended: 1, expired: 0 });
  expect(renderStatus(snapshot)).toContain("agent=working goal=active approval=false decisions=1");
  expect(renderStatus(snapshot)).toContain("question: Which option?");
  expect(contents()).toEqual(before);
  expect(
    world.calls.every(
      (c) => c[0] === "ps" || (c[0] === "herdr" && ["get", "list", "process-info", "read"].includes(c[2] ?? "")),
    ),
  ).toBe(true);
});

test("untrusted or reused pane identity is unknown, never a stale goal or approval", async () => {
  for (const patch of [{ pid: 77 }, { sessionId: "other" }]) {
    await deps().registry.write({ ...lane, session: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf" });
    laneState(state.dir, "w:p7", { ...patch, approvalPending: true });
    expect((await laneStatus(deps(), lane.key)).lanes[0]?.runtime).toBeNull();
  }
});

test.each([
  ["missing goal", { goal: undefined }],
  ["invalid goal object", { goal: null }],
  ["invalid goal enum", { goal: { status: "invalid" } }],
  ["invalid goal objective", { goal: { status: "active", objective: 12 } }],
  ["invalid agent enum", { agentStatus: "invalid" }],
  ["invalid approval flag", { approvalPending: "false" }],
  ["invalid observation timestamp", { updatedAt: "invalid" }],
] as const)("status degrades a trusted pane with %s without losing another lane", async (_label, patch) => {
  const flow = deps();
  await flow.registry.write({
    key: "healthy",
    title: "Healthy",
    thread: lane.thread,
    openedAt: lane.openedAt,
    brief: lane.brief,
    done: lane.done,
  });
  const path = paneStatePath(state.dir, lane.pane!);
  const original = JSON.parse(readFileSync(path, "utf8"));
  const ref = { runtime: "herdr", id: lane.pane! } as const;
  const runtime = runtimesOf(flow).for(ref);
  const identity = await runtime.probe(ref);
  expect(identity.sessionId).toBe(lane.session!);
  // The runtime attests identity before the status reader observes the state file.
  const probe = spyOn(runtime, "probe").mockImplementation(async () => {
    writeFileSync(path, JSON.stringify({ ...original, ...patch }));
    return identity;
  });
  try {
    const snapshot = await laneStatus(flow);
    expect(renderStatus(snapshot)).toContain("agent=unknown goal=unknown approval=unknown");
    expect(renderBoard(snapshot, "/home/test", 1960)).toContain(`${lane.key} | working | agent unknown`);
    expect(renderBoard(snapshot, "/home/test", 1960)).toContain("WARN incomplete observations");
    expect(JSON.parse(JSON.stringify(snapshot))).toMatchObject({
      registryIncomplete: false,
      lanes: [{ key: "healthy" }, { key: lane.key, runtime: null, errors: ["runtime observation invalid"] }],
    });
  } finally {
    probe.mockRestore();
  }
});

test("status accepts an older trusted record without agent status or goal objective", async () => {
  laneState(state.dir, lane.pane!, { goal: { status: "none" } });
  const snapshot = await laneStatus(deps());
  expect(snapshot.lanes[0]?.runtime).toEqual({
    goal: { status: "none" },
    approvalPending: false,
    updatedAt: lane.openedAt,
  });
  expect(renderStatus(snapshot)).toContain("agent=unknown goal=none approval=false");
});

test("approval, paused registry and last recorded sweep reasons stay distinct", async () => {
  laneState(state.dir, "w:p7", { approvalPending: true, agentStatus: "idle", goal: { status: "paused" } });
  await deps().registry.write({
    ...lane,
    status: "paused",
    lastFreshnessNote: "stale-report|already posted",
    lastNudgeAt: now - 5000,
  });
  const snapshot = await laneStatus(deps());
  expect(snapshot.lanes[0]).toMatchObject({
    status: "paused",
    lastSweepNote: "stale-report|already posted",
    lastNudgeAt: now - 5000,
  });
  expect(renderStatus(snapshot)).toContain("agent=idle goal=paused approval=true");
});

test("damaged journals are explicit, closed lanes are opt-in, invalid keys never escape the registry", async () => {
  const reports = new Reports(state.dir);
  reports.report(lane.key, "milestone", "ok", now);
  writeFileSync(reports.path(lane.key), "{broken");
  expect((await laneStatus(deps())).lanes[0]?.errors).toEqual(["report journal unreadable"]);
  await deps().registry.write({ ...lane, closedAt: new Date(now).toISOString() });
  expect((await laneStatus(deps())).lanes).toEqual([]);
  expect((await laneStatus(deps(), lane.key)).lanes[0]?.status).toBe("closed");
  await expect(laneStatus(deps(), "../escape")).rejects.toThrow("invalid lane key");
  await expect(laneStatus(deps(), "unknown")).rejects.toThrow("no registered lane");
});

test("board scrubs reports, bounds one message and ignores observation time when nothing changed", async () => {
  new Reports(state.dir).report(lane.key, "milestone", "file /home/test/secret.md pane w1:p2 @everyone $(cmd)", now);
  const snapshot = await laneStatus(deps());
  const body = renderBoard(snapshot, "/home/test", 1960);
  expect(body).not.toContain("/home/test");
  expect(body).not.toContain("w1:p2");
  expect(body).not.toContain("@everyone");
  expect(body).not.toContain("$(");
  expect(renderBoard({ ...snapshot, observedAt: new Date(now + 60_000).toISOString() }, "/home/test", 1960)).toBe(body);
  const many = { ...snapshot, lanes: Array.from({ length: 200 }, () => snapshot.lanes[0]!) };
  expect(renderBoard(many, "/home/test", 1960).length).toBeLessThanOrEqual(1960);
  expect(renderBoard(many, "/home/test", 1960)).toContain("more lanes");
});

test("ETA reports sample count and historical range, not a made-up estimate", () => {
  const closed = [10, 20, 40, 80].map((m, i) => ({
    ...lane,
    key: `deploy-${i}`,
    closedAt: new Date(Date.parse(lane.openedAt) + m * 60_000).toISOString(),
  }));
  expect(laneEta(closed.slice(0, 2), "deploy-").medianMinutes).toBeNull();
  const parked = { ...closed[0]!, key: "deploy-parked", receipt: { outcome: "parked" } };
  const abandoned = { ...closed[1]!, key: "deploy-abandoned", receipt: { outcome: "abandoned" } };
  const done = { ...closed[2]!, receipt: { outcome: "done" } };
  expect(laneEta([closed[0]!, closed[1]!, done, closed[3]!, parked, abandoned], "deploy-")).toEqual({
    prefix: "deploy-",
    samples: 4,
    medianMinutes: 30,
    minMinutes: 10,
    maxMinutes: 80,
  });
  expect(laneEta(closed, "other-").samples).toBe(0);
});

test("reverse registry clocks leave healthy status visible and suppress consumer ETA", async () => {
  await withDiscordCli(async (f) => {
    const registry = new Registry(dirname(f.tmp));
    await registry.write({ ...lane, key: "deploy-live" });
    for (const [i, elapsed] of [0, 20, 40].entries()) {
      await registry.write({
        ...lane,
        key: `deploy-${i}`,
        closedAt: new Date(Date.parse(lane.openedAt) + elapsed * 60_000).toISOString(),
      });
    }
    const goodEta = await f.invoke(["eta", "deploy-", "--json"]);
    expect(goodEta.code).toBe(0);
    expect(JSON.parse(goodEta.out)).toEqual({
      prefix: "deploy-",
      samples: 3,
      medianMinutes: 20,
      minMinutes: 0,
      maxMinutes: 40,
    });

    await registry.write({ ...lane, key: "deploy-reverse", closedAt: "2026-01-01T11:59:00.000Z" });
    const status = await f.invoke(["status", "--json"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ registryIncomplete: true, lanes: [{ key: "deploy-live" }] });
    const text = await f.invoke(["status", "deploy-reverse"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("LANES unknown (registry incomplete)");
    const eta = await f.invoke(["eta", "deploy-", "--json"]);
    expect(eta.code).toBe(0);
    expect(JSON.parse(eta.out)).toMatchObject({
      samples: 3,
      medianMinutes: null,
      minMinutes: null,
      maxMinutes: null,
      registryIncomplete: true,
    });
  });
});
