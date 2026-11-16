import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import { ready, report, startLane } from "../src/lanes.ts";
import { href } from "./fake.ts";
import { setup } from "./harness-setup.ts";

const MIN = 60_000;

async function quietLane() {
  const s = setup();
  const lane = await startLane(s.d, "epoch", s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.paneId)!;
  pane.status = "idle";
  const at = (min: number) => {
    s.w.clock = lane.createdAt + min * MIN;
    return dutyTick(s.d);
  };
  return { ...s, lane, pane, at };
}

describe("progress epochs", () => {
  test("new evidence after a backward clock adjustment reopens nudges and exactly one escalation", async () => {
    const { w, d, lane, lead, at } = await quietLane();
    expect(await at(40)).toContainEqual({ lane: "epoch", action: "escalated" });
    expect(d.store.lane("epoch")!.escalatedAt).toBe(w.clock);
    w.clock = lane.createdAt + 10 * MIN;
    await report(d, "epoch", "new proof after clock adjustment", { evidence: ["acme/app#201"] });
    expect(d.store.lane("epoch")).toMatchObject({ progressAt: w.clock, nudges: 0 });
    expect(d.store.lane("epoch")!.escalatedAt).toBeUndefined();
    expect(await at(20)).toContainEqual({ lane: "epoch", action: "nudge-1" });
    expect(await at(30)).toContainEqual({ lane: "epoch", action: "nudge-2" });
    expect(await at(49)).toEqual([]);
    expect(await at(50)).toContainEqual({ lane: "epoch", action: "escalated" });
    expect(await at(51)).toEqual([]);
    expect(lead.received.filter((text) => text.startsWith("[ESCALATE epoch]"))).toHaveLength(2);
  });

  test("an initial overdue escalation suppresses later nudges until new evidence starts an epoch", async () => {
    const { w, d, lane, pane, lead, at } = await quietLane();
    lead.status = "working";
    expect(await at(45)).toContainEqual({ lane: "epoch", action: "escalated" });
    const queuedEscalations = () =>
      d.store.queued(href("w1:p1")).filter((message) => message.text.startsWith("[ESCALATE epoch]"));
    expect(queuedEscalations()).toHaveLength(1);
    for (const min of [46, 60, 90]) expect(await at(min)).toEqual([]);
    expect(d.store.lane("epoch")!.nudges).toBe(0);
    expect(pane.received.filter((text) => text.startsWith("[duty"))).toEqual([]);
    expect(queuedEscalations()).toHaveLength(1);
    w.clock = lane.createdAt + 91 * MIN;
    await report(d, "epoch", "work resumed", { evidence: ["acme/app#202"] });
    expect(d.store.lane("epoch")!.escalatedAt).toBeUndefined();
    expect(await at(101)).toContainEqual({ lane: "epoch", action: "nudge-1" });
    expect(await at(111)).toContainEqual({ lane: "epoch", action: "nudge-2" });
    expect(await at(131)).toContainEqual({ lane: "epoch", action: "escalated" });
    expect(await at(132)).toEqual([]);
    expect(queuedEscalations()).toHaveLength(2);
  });

  test("READY starts an epoch even after clock rollback; working again reopens overdue supervision", async () => {
    const { w, d, lane, lead, at } = await quietLane();
    expect(await at(10)).toContainEqual({ lane: "epoch", action: "nudge-1" });
    expect(await at(40)).toContainEqual({ lane: "epoch", action: "escalated" });
    w.clock = lane.createdAt + 10 * MIN;
    await ready(d, "epoch", "ready for review", ["acme/app#203"]);
    expect(d.store.lane("epoch")).toMatchObject({ status: "ready", progressAt: w.clock, nudges: 0 });
    expect(d.store.lane("epoch")!.escalatedAt).toBeUndefined();
    expect(await at(55)).toEqual([]);
    await report(d, "epoch", "review requires more work", { status: "working" });
    expect(d.store.lane("epoch")!.progressAt).toBe(lane.createdAt + 10 * MIN);
    expect(await at(55)).toContainEqual({ lane: "epoch", action: "escalated" });
    expect(await at(56)).toEqual([]);
    expect(lead.received.filter((text) => text.startsWith("[ESCALATE epoch]"))).toHaveLength(2);
  });

  test("directory entry changes are not progress, while a symlink to a changed regular file counts once", async () => {
    const { w, d, lane, at } = await quietLane();
    w.clock = lane.createdAt + 10 * MIN;
    const directory = join(d.store.root, "artifacts");
    mkdirSync(directory);
    writeFileSync(join(directory, "unrelated.tmp"), "directory churn");
    utimesSync(directory, w.clock / 1000, w.clock / 1000);
    const skipped = await report(d, "epoch", "directory changed", { evidence: [directory] });
    expect(skipped.progress[0]).toStartWith("PROGRESS unchanged since");
    expect(skipped.progress[1]).toContain("(not a regular file)");
    expect(d.store.lane("epoch")!.progressAt).toBe(lane.createdAt);
    expect(await at(40)).toContainEqual({ lane: "epoch", action: "escalated" });
    w.clock = lane.createdAt + 41 * MIN;
    const file = join(directory, "proof.txt");
    const link = join(d.store.root, "proof-link");
    writeFileSync(file, "new result");
    utimesSync(file, w.clock / 1000, w.clock / 1000);
    symlinkSync(file, link);
    const moved = await report(d, "epoch", "regular file proof", { evidence: [link] });
    expect(moved.progress[0]).toMatch(/^PROGRESS \d\d:\d\d: .*proof-link$/);
    expect(d.store.lane("epoch")).toMatchObject({ progressAt: w.clock, nudges: 0 });
    expect(d.store.lane("epoch")!.escalatedAt).toBeUndefined();
    w.clock += MIN;
    const repeated = await report(d, "epoch", "same proof", { evidence: [link] });
    expect(repeated.progress[0]).toStartWith("PROGRESS unchanged since");
    expect(d.store.lane("epoch")!.progressAt).toBe(lane.createdAt + 41 * MIN);
  });

  test.each([40, 50])(
    "an existing marker at minute %i does not suppress the epoch that progressed at minute 50",
    async (markerMin) => {
      const { d, lane, lead, at } = await quietLane();
      d.store.saveLane({
        ...d.store.lane("epoch")!,
        progressAt: lane.createdAt + 50 * MIN,
        lastActivityAt: lane.createdAt + 50 * MIN,
        escalatedAt: lane.createdAt + markerMin * MIN,
      });
      expect(await at(60)).toContainEqual({ lane: "epoch", action: "nudge-1" });
      expect(await at(70)).toContainEqual({ lane: "epoch", action: "nudge-2" });
      expect(await at(89)).toEqual([]);
      expect(await at(90)).toContainEqual({ lane: "epoch", action: "escalated" });
      expect(d.store.lane("epoch")!.escalatedAt).toBe(lane.createdAt + 90 * MIN);
      expect(await at(91)).toEqual([]);
      expect(lead.received.filter((text) => text.startsWith("[ESCALATE epoch]"))).toHaveLength(1);
    },
  );
});
