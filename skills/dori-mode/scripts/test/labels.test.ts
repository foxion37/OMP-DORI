import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { applyLaneLabel, laneLabel, laneLabelOf } from "../src/labels.ts";
import { launchLane } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { relayLane } from "../src/relay.ts";
import { depsFor, fakeClock, newWorld, ompPane, type TestState, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: TestState;
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
  const stored = {
    key: "k",
    title: "이름",
    thread: "none",
    label: "TLGR : 이름",
    brief: "/b.md",
    done: "file /tmp/x",
    openedAt: "2026-01-01T00:00:00.000Z",
  } as Lane;
  expect(laneLabelOf(stored)).toBe("TLGR : 이름");
  const { label: _drop, ...older } = stored;
  expect(laneLabelOf(older as Lane)).toBe("이름");
});

test("label: applying it renames the pane, and the tab and workspace dori made for the lane, reporting failures", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  expect(
    await applyLaneLabel(deps, { runtime: "herdr", pane: "w1:p2", tab: "w1:t1", workspace: "w1" }, "DICO : 이름"),
  ).toEqual([]);
  expect(renames(world)).toEqual([
    ["herdr", "tab", "rename", "w1:t1", "DICO : 이름"],
    ["herdr", "workspace", "rename", "w1", "DICO : 이름"],
    ["herdr", "pane", "rename", "w1:p2", "DICO : 이름"],
  ]);
  // hc has no such names to change: nothing is renamed, and nothing is reported.
  world.calls = [];
  expect(await applyLaneLabel(deps, { runtime: "hc", pane: "t1b" }, "TLGR : 정리")).toEqual([]);
  expect(renames(world)).toEqual([]);
  const failing: FlowDeps = {
    ...deps,
    run: async (argv) =>
      argv[2] === "rename" && argv[1] === "pane"
        ? { code: 1, out: "", err: "no such pane" }
        : { code: 0, out: "", err: "" },
  };
  expect(await applyLaneLabel(failing, { runtime: "herdr", pane: "w1:p9" }, "TLGR : 정리")).toEqual([
    "LABEL_FAILED pane w1:p9: no such pane",
  ]);
});

/** A tab create answered the way herdr does, on top of the plain world. */
const tabbed = (): FlowDeps => {
  const base = depsFor(world, fakeClock(T0), state.dir, { goalMarker: "" });
  return {
    ...base,
    run: async (argv) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
        world.calls.push([...argv]);
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" } } }),
          err: "",
        };
      }
      return base.run(argv);
    },
  };
};

test("launch: the tab, the pane and the agent's environment all carry the ticker label", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const deps = tabbed();
  ompPane(world, state.dir, "w1:p2", 4242);
  const r = await launchLane(deps, {
    key: "name-test",
    title: "이름 시험",
    thread: "telegram:6407400094",
    brief,
    done: "file /tmp/name-test-done",
  });
  expect(r.lane.label).toBe("TLGR : 이름 시험");
  const create = world.calls.find((c) => c[0] === "herdr" && c[1] === "tab" && c[2] === "create") ?? [];
  expect(create).toContain("TLGR : 이름 시험");
  expect(create).toContain("DORI_LANE_LABEL=TLGR : 이름 시험");
  const run = world.calls.find((c) => c[0] === "herdr" && c[2] === "run");
  expect(run?.[4]).toContain("Read and execute the lane brief at");
  // A tab dori created already carries the label: no second rename.
  expect(renames(world)).toEqual([]);
});

test("launch: a split pane is renamed to the lane's label", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const base = depsFor(world, fakeClock(T0), state.dir, { goalMarker: "" });
  const deps: FlowDeps = {
    ...base,
    run: async (argv) => {
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "split") {
        world.calls.push([...argv]);
        ompPane(world, state.dir, "w9:new1", 5000);
        return {
          code: 0,
          out: JSON.stringify({ result: { pane: { pane_id: "w9:new1", tab_id: "w9:t1", workspace_id: "w9" } } }),
          err: "",
        };
      }
      return base.run(argv);
    },
  };
  await deps.registry.write({
    key: "mate",
    title: "mate",
    thread: "none",
    pane: "w9:mate",
    brief: "/b.md",
    done: "file /tmp/x",
    openedAt: new Date(T0 - 1000).toISOString(),
    group: "grp",
  });
  ompPane(world, state.dir, "w9:mate", 4242);
  const r = await launchLane(deps, {
    key: "split-lane",
    title: "로컬 점검",
    brief,
    done: "file /tmp/split-done",
    group: "grp",
  });
  expect(r.lane.placement).toBe("split");
  expect(renames(world)).toEqual([["herdr", "pane", "rename", "w9:new1", "로컬 점검"]]);
});

const splitAnswer = () => (argv: readonly string[]) => {
  if (argv[0] !== "herdr" || argv[1] !== "pane" || argv[2] !== "split") return undefined;
  world.calls.push([...argv]);
  ompPane(world, state.dir, "w9:new1", 5000);
  return {
    code: 0,
    out: JSON.stringify({ result: { pane: { pane_id: "w9:new1", tab_id: "w9:t1", workspace_id: "w9" } } }),
    err: "",
  };
};

test("relay: the successor pane gets the same label, and a record from before labels derives one", async () => {
  const handoff = join(state.dir, "handoffs", "rl-keep-1.md");
  const base = depsFor(world, fakeClock(T0), state.dir, { relayTimeoutMin: 1 });
  const split = splitAnswer();
  const deps: FlowDeps = { ...base, run: async (argv) => split(argv) ?? base.run(argv) };
  const opened: Lane = {
    key: "rl-keep",
    title: "Relayer2 완전 종료",
    thread: "telegram:6407400094",
    pane: "w9:rl",
    brief: "/b.md",
    done: "file /tmp/rl-done",
    openedAt: new Date(T0).toISOString(),
    cwd: "/repo",
    model: "kiro-dori/claude-haiku-5.5",
  };
  await deps.registry.write(opened);
  ompPane(world, state.dir, "w9:rl", 4242);
  world.onSendText = () => writeFileSync(handoff, "# handoff\n");

  expect((await relayLane(deps, opened)).lines).toEqual(["RELAYED rl-keep w9:rl -> w9:new1"]);
  expect(renames(world)).toEqual([["herdr", "pane", "rename", "w9:new1", "TLGR : Relayer2 완전 종료"]]);
  const splitCall = world.calls.find((c) => c[0] === "herdr" && c[2] === "split") ?? [];
  expect(splitCall).toContain("DORI_LANE_LABEL=TLGR : Relayer2 완전 종료");
  expect(((await deps.registry.read("rl-keep")) as Lane).label).toBe("TLGR : Relayer2 완전 종료");
});
