import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readPaneState, writePaneState } from "../src/lane-state.ts";
import { parkLane } from "../src/park.ts";
import { sessionFields, sessionOf } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import { runtimesOf } from "../src/run.ts";
import { laneState, sent } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
const otherSession = "01a11440-ee81-7f90-b2ed-dcc7d51a0ade";

beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

const writeOtherSession = (): string => {
  const file = join(dirname(f.file), `2026-01-01T12-01-00-000Z_${otherSession}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id: otherSession, cwd: f.deps.config.defaultCwd })}\n`);
  return file;
};

test.each(["parked", "abandoned"] as const)("%s holds if OMP switches during a screen read", async (outcome) => {
  const pane = sessionOf(f.lane)!.id;
  const registryBefore = await f.deps.registry.read(f.lane.key);
  const receipt = readPaneState(f.state.dir, pane);
  if (!receipt) throw new Error("missing original OMP pane receipt");
  expect(receipt.sessionId).toBe(f.session);
  const replacement = { ...receipt, sessionId: otherSession, sessionFile: writeOtherSession() };
  let switched = false;
  const result = await parkLane(
    {
      ...f.deps,
      run: async (argv, options) => {
        const response = await f.deps.run(argv, options);
        const [cmd, scope, action, id, flag, lines] = argv;
        const goalRead = [cmd, scope, action, id, flag, lines].join(" ") === `herdr pane read ${pane} --lines 200`;
        if (!switched && goalRead) {
          // Return the real fixture response, but switch OMP's session before the caller resumes from its read.
          writePaneState(f.state.dir, replacement);
          switched = true;
        }
        return response;
      },
    },
    f.lane,
    "owner asked to stop",
    outcome,
  );

  expect(switched).toBe(true);
  const effects = f.world.calls.filter(
    ([cmd, scope, action]) =>
      cmd === "herdr" &&
      ((scope === "agent" && action === "prompt") ||
        (scope === "pane" && (action === "send-text" || action === "send-keys" || action === "close"))),
  );
  expect({ code: result.code, effects }).toEqual({ code: 3, effects: [] });
  expect(result.lines.join("\n")).toContain("PAUSE_UNVERIFIED");
  expect(await f.deps.registry.read(f.lane.key)).toEqual(registryBefore);
  expect(readPaneState(f.state.dir, pane)).toEqual(replacement);
});

test.each(["same", "different"] as const)("Herdr checks a registered hc peer with the %s ID", async (relation) => {
  const duplicate = relation === "same";
  const parked = await parkLane(f.deps, f.lane, "owner asked to stop");
  expect(parked.code).toBe(0);
  expect(sessionOf(parked.lane)?.runtime).toBe("herdr");
  expect(f.deps.config.runtime).toBe("herdr");

  const peer = { runtime: "hc", id: "t7" } as const;
  const pid = 4300;
  const cwd = f.deps.config.defaultCwd;
  const session = duplicate ? f.session : otherSession;
  const sessionFile = duplicate ? f.file : writeOtherSession();
  f.world.terminals[peer.id] = hcTerm({
    cwd,
    pid,
    status: { state: "idle", app: "omp" },
    foreground: { name: "omp", argv: ["omp"], pid },
  });
  f.world.procs = [...(f.world.procs ?? []), { pid, ppid: 1, cmd: "omp --dori-role lane" }];
  laneState(f.state.dir, peer.id, { cwd, pid, sessionId: session, sessionFile });
  const { tab: _tab, ...base } = f.lane;
  await f.deps.registry.write({
    ...base,
    ...sessionFields(peer),
    key: "hc-peer",
    title: "hc peer",
    session,
    sessionFile,
  });

  // Prove the receipt through hc without preloading hc into the fresh reopen invocation's runtime cache.
  const proof = await runtimesOf({ ...f.deps })
    .for(peer)
    .probe(peer);
  expect(proof).toMatchObject({ status: "idle", shellInFront: false, pid, sessionId: session, sessionFile });
  const deps = { ...f.deps };
  const registryBefore = await deps.registry.read(parked.lane.key);
  f.world.calls.length = 0;
  const result = await reopenLane(deps, parked.lane);
  const effects = { code: result.code, creates: f.creates(), goalInput: sent(f.world) };

  if (duplicate) {
    expect(effects).toEqual({ code: 3, creates: 0, goalInput: [] });
    expect(result.lines.join("\n")).toContain(`already running in ${peer.id}`);
    expect(f.world.calls).toContainEqual(["hc", "--json", "get", peer.id]);
    expect(await deps.registry.read(parked.lane.key)).toEqual(registryBefore);
  } else {
    expect(effects).toEqual({ code: 0, creates: 1, goalInput: ["/goal resume"] });
    expect(result.lane).toMatchObject({ pane: "w1:p8", session: f.session, status: "working" });
    const start = f.world.calls.find(([cmd, scope, action]) => cmd === "herdr" && scope === "pane" && action === "run");
    expect(start?.[4]).toContain(`--resume=${f.file}`);
  }
});
