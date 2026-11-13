import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { applyLaneLabel, laneLabel, laneLabelOf } from "../src/labels.ts";
import { launchLane } from "../src/launch.ts";
import { type Lane } from "../src/registry.ts";
import { relayLane } from "../src/relay.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: { dir: string; done: () => void };
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const renames = (w: World): string[][] => w.calls.filter((c) => c[0] === "herdr" && c[2] === "rename");

test("label: a Discord lane reads DICO, a Telegram lane TLGR, and a lane without a thread its bare title", () => {
  expect(laneLabel({ title: "OMP 이름 설정", thread: "discord:1488" })).toBe("DICO : OMP 이름 설정");
  expect(laneLabel({ title: "1Password 정리", thread: "telegram:6407400094" })).toBe("TLGR : 1Password 정리");
  expect(laneLabel({ title: "로컬 점검", thread: "none" })).toBe("로컬 점검");
  expect(laneLabel({ title: "Slack 쪽", thread: "slack:C123" })).toBe("Slack 쪽");
  expect(laneLabel({ title: "이름", thread: "" })).toBe("이름");
});

test("label: a record keeps the label it was launched with, and an older record derives one from its thread", () => {
  const stored = { key: "k", title: "이름", thread: "none", label: "TLGR : 이름", brief: "/b.md", done: "file /tmp/x", openedAt: "2026-01-01T00:00:00.000Z" } as Lane;
  expect(laneLabelOf(stored)).toBe("TLGR : 이름");
  const { label: _drop, ...older } = stored;
  expect(laneLabelOf(older as Lane)).toBe("이름");
});

test("label: applying it renames the pane, and the tab and workspace dori made for the lane, reporting failures", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  expect(await applyLaneLabel(deps, { pane: "w1:p2", tab: "w1:t1", workspace: "w1" }, "DICO : 이름")).toEqual([]);
  expect(renames(world)).toEqual([
    ["herdr", "tab", "rename", "w1:t1", "DICO : 이름"],
    ["herdr", "workspace", "rename", "w1", "DICO : 이름"],
    ["herdr", "pane", "rename", "w1:p2", "DICO : 이름"],
  ]);
  world.calls = [];
  const failing: FlowDeps = { ...deps, run: async (argv) => (argv[2] === "rename" && argv[1] === "pane" ? { code: 1, out: "", err: "no such pane" } : { code: 0, out: "", err: "" }) };
  expect(await applyLaneLabel(failing, { pane: "w1:p9" }, "TLGR : 정리")).toEqual(["LABEL_FAILED pane w1:p9: no such pane"]);
});

test("launch: the lane record, the pane label and the agent's environment all carry the ticker label", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const base = depsFor(world, fakeClock(T0), state.dir);
  const deps: FlowDeps = {
    ...base,
    run: async (argv) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" } } }), err: "" };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "w1:p2", workspace_id: "w1", agent: "omp", agent_status: "idle" }] } }), err: "" };
      return fakeRunner(world)(argv);
    },
  };
  const r = await launchLane(deps, { key: "name-test", title: "이름 시험", thread: "telegram:6407400094", brief, done: "file /tmp/name-test-done" });
  expect(r.lane.label).toBe("TLGR : 이름 시험");
  expect(r.labels).toEqual([]);
  expect(renames(world)).toEqual([["herdr", "pane", "rename", "w1:p2", "TLGR : 이름 시험"]]);
  const run = world.calls.find((c) => c[0] === "herdr" && c[2] === "run");
  expect(run?.[4]).toStartWith(`env 'DORI_LANE_LABEL=TLGR : 이름 시험' omp --dori-role lane --model `);
  expect(run?.[4]).toContain("Read and execute the lane brief at");
});

test("launch: a lane without a thread puts its bare title on the pane", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const base = depsFor(world, fakeClock(T0), state.dir);
  const deps: FlowDeps = {
    ...base,
    run: async (argv) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" } } }), err: "" };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "w1:p2", workspace_id: "w1", agent: "omp", agent_status: "idle" }] } }), err: "" };
      return fakeRunner(world)(argv);
    },
  };
  const r = await launchLane(deps, { key: "local-check", title: "로컬 점검", brief, done: "file /tmp/local-check-done" });
  expect(r.lane.label).toBe("로컬 점검");
  expect(renames(world)).toEqual([["herdr", "pane", "rename", "w1:p2", "로컬 점검"]]);
});

const herdr = (w: World, next: { n: number }) => {
  const inner = fakeRunner(w);
  return async (argv: readonly string[]) => {
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "split") {
      w.calls.push([...argv]);
      const id = `w9:new${++next.n}`;
      w.panes.push({ pane_id: id, workspace_id: "w9", agent: "omp", agent_status: "idle" });
      return { code: 0, out: JSON.stringify({ result: { pane: { pane_id: id, tab_id: "w9:t1", workspace_id: "w9" } } }), err: "" };
    }
    return inner(argv);
  };
};

test("relay: the successor pane gets the same label, and the record keeps it", async () => {
  const key = "rl-keep";
  const handoff = join(state.dir, "handoffs", `${key}-1.md`);
  const deps: FlowDeps = { ...depsFor(world, fakeClock(T0), state.dir), run: herdr(world, { n: 0 }) };
  const opened: Lane = { key, title: "OMP 이름 설정", thread: "discord:1488", label: "DICO : OMP 이름 설정", pane: "w9:rl", brief: "/b.md", done: "file /tmp/rl-done", openedAt: new Date(T0).toISOString(), cwd: "/repo", model: "kiro-dori/claude-haiku-5.5" };
  await deps.registry.write(opened);
  world.onSendText = () => writeFileSync(handoff, "# handoff\n");
  world.panes.push({ pane_id: "w9:rl", workspace_id: "w9", agent: "omp", agent_status: "idle" });

  const r = await relayLane(deps, opened);
  expect(r.lines).toEqual(["RELAYED rl-keep w9:rl -> w9:new1"]);
  expect(renames(world)).toEqual([["herdr", "pane", "rename", "w9:new1", "DICO : OMP 이름 설정"]]);
  const run = world.calls.find((c) => c[0] === "herdr" && c[2] === "run");
  expect(run?.[4]).toStartWith("env 'DORI_LANE_LABEL=DICO : OMP 이름 설정' omp --dori-role lane");
  const saved = (await deps.registry.read(key)) as Lane;
  expect(saved.label).toBe("DICO : OMP 이름 설정");
});

test("relay: a lane recorded before labels existed derives its own and keeps it for the successor", async () => {
  const key = "rl-derive";
  const handoff = join(state.dir, "handoffs", `${key}-1.md`);
  const deps: FlowDeps = { ...depsFor(world, fakeClock(T0), state.dir), run: herdr(world, { n: 0 }) };
  const opened: Lane = { key, title: "Relayer2 완전 종료", thread: "telegram:6407400094", pane: "w9:rl", brief: "/b.md", done: "file /tmp/rl-done", openedAt: new Date(T0).toISOString(), cwd: "/repo", model: "kiro-dori/claude-haiku-5.5" };
  await deps.registry.write(opened);
  world.onSendText = () => writeFileSync(handoff, "# handoff\n");
  world.panes.push({ pane_id: "w9:rl", workspace_id: "w9", agent: "omp", agent_status: "idle" });

  expect((await relayLane(deps, opened)).lines).toEqual([`RELAYED ${key} w9:rl -> w9:new1`]);
  expect(renames(world)).toEqual([["herdr", "pane", "rename", "w9:new1", "TLGR : Relayer2 완전 종료"]]);
  expect(((await deps.registry.read(key)) as Lane).label).toBe("TLGR : Relayer2 완전 종료");
});
