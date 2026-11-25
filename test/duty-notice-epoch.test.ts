import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { ready, report, startLane } from "../src/lanes.ts";
import type { Lane } from "../src/store-types.ts";
import { Store } from "../src/store.ts";
import { LEAD_REF, setup } from "./harness-setup.ts";

const MIN = 60_000;

async function quietLane() {
  const s = setup();
  const lane = await startLane(s.d, "talker", s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.sessionRef.id)!;
  pane.status = "idle";
  s.lead.received.length = 0;
  const at = (min: number) => {
    s.w.clock = lane.createdAt + min * MIN;
    return dutyTick(s.d);
  };
  const told = (tag: string) => s.lead.received.join("\n").split(`[${tag} talker]`).length - 1;
  return { ...s, lane, pane, at, told };
}

/** Stop once after a notice is queued, before its nudge count or status is persisted. */
function interruptSave(d: Deps, notice: (lane: Lane) => boolean): void {
  const withCurrent = d.store.withCurrentLane.bind(d.store);
  d.store.withCurrentLane = (key, fn) =>
    withCurrent(key, (current, save) =>
      fn(current, (lane) => {
        if (notice(lane)) {
          d.store.withCurrentLane = withCurrent;
          throw new Error("stopped before saving the notice marker");
        }
        save(lane);
      }),
    );
}

describe("duty notice identities across progress epochs and lane incarnations", () => {
  test("nudge-only rollback: new evidence at the same timestamp delivers another first nudge", async () => {
    const { w, d, lane, pane, at, told } = await quietLane();
    const progress = lane.createdAt + 5 * MIN;
    w.clock = progress;
    await report(d, "talker", "first epoch", { evidence: ["https://example.test/evidence/1"] });
    expect(await at(15)).toContainEqual({ lane: "talker", action: "nudge-1" });
    expect(pane.received.filter((m) => m.includes("[duty -> talker]"))).toHaveLength(1);
    w.clock = progress;
    await report(d, "talker", "second epoch at the same time", { evidence: ["https://example.test/evidence/2"] });
    expect(d.store.lane("talker")).toMatchObject({ progressAt: progress, nudges: 0 });
    expect(await at(15)).toContainEqual({ lane: "talker", action: "nudge-1" });
    await at(16);
    expect(pane.received.filter((m) => m.includes("[duty -> talker]"))).toHaveLength(2);
    expect(told("ESCALATE")).toBe(0);
  });

  test("new evidence at a previously used timestamp after rollback delivers a fresh nudge and escalation", async () => {
    const { w, d, lane, pane, at, told } = await quietLane();
    const progress = lane.createdAt + 5 * MIN;
    w.clock = progress;
    await report(d, "talker", "first evidence", { evidence: ["acme/app#1"] });
    await at(15);
    await at(45);
    expect(pane.received.filter((m) => m.includes("[duty -> talker]"))).toHaveLength(1);
    expect(told("ESCALATE")).toBe(1);
    w.clock = progress;
    await report(d, "talker", "new evidence after rollback", { evidence: ["acme/app#2"] });
    expect(d.store.lane("talker")).toMatchObject({ progressAt: progress, nudges: 0 });
    expect(d.store.lane("talker")!.escalatedAt).toBeUndefined();
    expect(await at(15)).toContainEqual({ lane: "talker", action: "nudge-1" });
    expect(pane.received.filter((m) => m.includes("[duty -> talker]"))).toHaveLength(2);
    expect(await at(45)).toContainEqual({ lane: "talker", action: "escalated" });
    await at(46);
    expect(told("ESCALATE")).toBe(2);
  });

  test("READY opens a fresh epoch at the same timestamp and a restarted nudge retry keeps that identity", async () => {
    const { w, d, lane, pane, at, told } = await quietLane();
    await at(10);
    await at(40);
    w.clock = lane.createdAt;
    await ready(d, "talker", "finished", ["acme/app#3"]);
    expect(d.store.lane("talker")).toMatchObject({ status: "ready", nudges: 0 });
    expect(d.store.lane("talker")!.escalatedAt).toBeUndefined();
    await report(d, "talker", "follow-up work", { status: "working" });
    interruptSave(d, (next) => next.nudges === 1);
    expect(await at(10)).toContainEqual(expect.objectContaining({ lane: "talker", action: "lane-failed" }));
    const queued = d.store.queued(lane.sessionRef);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBeDefined();
    expect(d.store.lane("talker")!.nudges).toBe(0);
    w.clock = lane.createdAt + 11 * MIN;
    await dutyTick({ ...d, store: new Store(d.store.root) });
    await at(12);
    expect(pane.received.filter((m) => m.includes("[duty -> talker]"))).toHaveLength(2);
    expect(d.store.lane("talker")!.nudges).toBe(1);
    expect(d.store.queued(lane.sessionRef)).toEqual([]);
    await at(40);
    await at(41);
    expect(told("ESCALATE")).toBe(2);
  });

  test.each([false, true])(
    "reusing a key, timestamp and pane id still delivers both LOST notices (lead registered: %s)",
    async (registered) => {
      const { w, d, lane, brief, told } = await quietLane();
      if (!registered) rmSync(join(d.store.root, "roles.json"));
      const serial = w.next;
      w.panes.delete(lane.sessionRef.id);
      await dutyTick(d);
      expect(d.store.lane("talker")!.status).toBe("lost");
      // A restarted runtime can reuse its pane numbers while the wall clock also repeats.
      w.next = serial - 1;
      const again = await startLane(d, "talker", brief, { group: "w1" });
      expect(again.createdAt).toBe(lane.createdAt);
      expect(again.sessionRef).toEqual(lane.sessionRef);
      w.panes.delete(again.sessionRef.id);
      await dutyTick(d);
      d.store.setRole("lead", LEAD_REF);
      await dutyTick(d);
      await dutyTick(d);
      expect(told("LOST")).toBe(2);
      expect(d.store.queued(LEAD_REF)).toEqual([]);
    },
  );
});
