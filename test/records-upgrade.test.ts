import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { status } from "../src/cli-up.ts";
import { dutyTick } from "../src/duty.ts";
import { RuntimeChoiceError } from "../src/runtime/select.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { Store } from "../src/store.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

const MIN = 60_000;

// A lanes/<key>.json and a roles.json exactly as a binary from before runtimes existed wrote them.
const OLD_LANE = {
  key: "old-lane",
  paneId: "w1:p3",
  tabId: "w1:t3",
  brief: "/b.md",
  cwd: "/w",
  status: "working",
  createdAt: 1,
  lastActivityAt: 1,
  nudges: 0,
  log: [],
};

function oldHome() {
  const w = new World();
  const d = w.deps();
  const laneFile = join(d.store.root, "lanes", "old-lane.json");
  writeFileSync(laneFile, JSON.stringify(OLD_LANE));
  writeFileSync(
    join(d.store.root, "lanes", "no-tab.json"),
    JSON.stringify({ ...OLD_LANE, key: "no-tab", tabId: "", createdAt: 2 }),
  );
  writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "w1:p1", duty: "w1:p2" }));
  return { w, d, laneFile };
}

describe("records written before runtimes existed (IS-3)", () => {
  test("lane() and lanes() read an old lane as the herdr pane it names; bare roles are herdr refs", () => {
    const { d } = oldHome();
    const want: SessionRef = { runtime: "herdr", id: "w1:p3", container: "w1:t3" };
    const bare: SessionRef = { runtime: "herdr", id: "w1:p3" };
    expect(d.store.lane("old-lane")?.sessionRef).toEqual(want);
    expect(d.store.lanes().map((l) => l.sessionRef)).toEqual([want, bare]);
    expect(d.store.roles()).toEqual({
      lead: { runtime: "herdr", id: "w1:p1" },
      duty: { runtime: "herdr", id: "w1:p2" },
    });
    expect(d.store.laneBySession({ runtime: "herdr", id: "w1:p3" })?.key).toBe("old-lane");
  });

  test("run twice, the result is identical; reading writes nothing, saving keeps paneId/tabId and saves the same bytes again", () => {
    const { d, laneFile } = oldHome();
    const before = readFileSync(laneFile, "utf8");
    const first = { lane: d.store.lane("old-lane"), lanes: d.store.lanes(), roles: d.store.roles() };
    const second = { lane: d.store.lane("old-lane"), lanes: d.store.lanes(), roles: d.store.roles() };
    expect(second).toEqual(first);
    expect(readFileSync(laneFile, "utf8")).toBe(before);
    d.store.saveLane(first.lane!);
    const saved = readFileSync(laneFile, "utf8");
    expect(JSON.parse(saved)).toMatchObject({ paneId: "w1:p3", tabId: "w1:t3", sessionRef: first.lane!.sessionRef });
    d.store.saveLane(d.store.lane("old-lane")!);
    expect(readFileSync(laneFile, "utf8")).toBe(saved);
    expect(d.store.lane("old-lane")).toEqual(first.lane!);
  });

  test("dori status shows the old lane as w1:p3 beside a herdr runtime column, the way it prints roles", async () => {
    const { d } = oldHome();
    const { out } = await captureIo(async () => {
      status(d);
      return 0;
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("RUNTIME herdr (from config)");
    expect(lines[1]).toBe("lead=w1:p1 duty=w1:p2");
    expect(lines[2]).toBe(`home=${d.store.root}`);
    expect(lines.find((l) => l.startsWith("old-lane"))).toMatch(/^old-lane\s+working\s+herdr\s+w1:p3\s/);
  });

  test("dori status with a long home path holding spaces and an unset runtime: each path whole on one line", async () => {
    const { d } = oldHome();
    // Spaces inside a path are no place to break it: either half names no directory.
    const root = join(d.store.root, "Application Support", `${"deep home directory ".repeat(6)}end`);
    const config = join(root, "config.json");
    const long = {
      ...d,
      store: new Store(root),
      choice: () => {
        throw new RuntimeChoiceError(`neither herdr nor hc is on PATH: set "runtime" in ${config}`);
      },
    };
    const { out } = await captureIo(async () => {
      status(long);
      return 0;
    });
    expect(Bun.stringWidth(root)).toBeGreaterThan(120);
    // The two path lines run past 120 columns as they must; the terminal folds them, a copy of each is whole.
    expect(out.split("\n").slice(0, 3)).toEqual([
      `RUNTIME unset: neither herdr nor hc is on PATH: set "runtime" in ${config}`,
      "lead=- duty=-",
      `home=${root}`,
    ]);
  });

  test.each([2, 3])("a legacy record with %s nudges establishes one verifiable queued escalation", async (nudges) => {
    const { w, d } = oldHome();
    rmSync(join(d.store.root, "lanes", "no-tab.json"));
    const lead = w.addPane("w1:p1", "working");
    w.addPane("w1:p3", "idle");
    const nudge = (at: number) => ({ at, kind: "nudge" as const, text: "idle" });
    const legacy = {
      ...d.store.lane("old-lane")!,
      nudges,
      log: [nudge(10 * MIN), nudge(20 * MIN), nudge(40 * MIN)].slice(0, nudges),
    };
    d.store.saveLane(legacy);
    w.clock = 90 * MIN;
    expect(await dutyTick(d)).toEqual([{ lane: "old-lane", action: "escalated" }]);
    expect(d.store.lane("old-lane")!.escalatedAt).toBe(w.clock);
    expect(d.store.queued(legacy.sessionRef)).toEqual([]);
    const leadRef = { runtime: "herdr" as const, id: "w1:p1" };
    expect(d.store.queued(leadRef)).toEqual([
      expect.objectContaining({ at: w.clock, from: "duty", text: expect.stringContaining("[ESCALATE old-lane]") }),
    ]);
    w.clock += MIN;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.queued(leadRef)).toHaveLength(1);
    lead.status = "idle";
    expect(await dutyTick(d)).toEqual([{ pane: "w1:p1", action: "flushed" }]);
    const escalated = lead.received.filter((text) => text.startsWith("[ESCALATE old-lane]"));
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toStartWith("[ESCALATE old-lane] no new evidence for 1h29m");
    expect(d.store.queued(leadRef)).toEqual([]);
  });

  test("a legacy third nudge without a lead is not marked until one escalation can be queued", async () => {
    const { w, d } = oldHome();
    rmSync(join(d.store.root, "lanes", "no-tab.json"));
    rmSync(join(d.store.root, "roles.json"));
    const lead = w.addPane("w1:p1", "working");
    w.addPane("w1:p3", "idle");
    const legacy = d.store.lane("old-lane")!;
    legacy.nudges = 3;
    legacy.log = [10, 20, 40].map((min) => ({ at: min * MIN, kind: "nudge" as const, text: "idle" }));
    d.store.saveLane(legacy);
    w.clock = 90 * MIN;
    expect(await dutyTick(d)).toEqual([expect.objectContaining({ lane: "old-lane", action: "escalate-no-lead" })]);
    expect(d.store.lane("old-lane")!.escalatedAt).toBeUndefined();
    expect(d.store.lane("old-lane")!.log.some((entry) => entry.kind === "escalate")).toBe(false);
    const leadRef = { runtime: "herdr" as const, id: "w1:p1" };
    expect(d.store.queued(leadRef)).toEqual([]);
    d.store.setRole("lead", leadRef);
    expect(await dutyTick(d)).toEqual([{ lane: "old-lane", action: "escalated" }]);
    expect(d.store.lane("old-lane")!.escalatedAt).toBe(w.clock);
    expect(d.store.queued(leadRef)).toHaveLength(1);
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.queued(leadRef)).toHaveLength(1);
    lead.status = "idle";
    await dutyTick(d);
    expect(lead.received.filter((text) => text.includes("[ESCALATE old-lane]"))).toHaveLength(1);
  });
});
