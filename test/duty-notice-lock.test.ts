import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { startLane } from "../src/lanes.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { href } from "./fake.ts";
import { setup } from "./harness-setup.ts";

async function quietLane() {
  const s = setup();
  const lane = await startLane(s.d, "talker", s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.paneId)!;
  pane.status = "idle";
  s.lead.received.length = 0;
  const at = (min: number) => {
    s.w.clock = lane.createdAt + min * 60_000;
    return dutyTick(s.d);
  };
  const told = (tag: string) => s.lead.received.join("\n").split(`[${tag} talker]`).length - 1;
  return { ...s, lane, pane, at, told };
}

/**
 * Another process's flush of `ref`, stopped between reading the queue and writing it back: it holds the inbox lock and
 * has read the queue; `finish` writes back what it read (its batch settled, the rest as read) and releases the lock.
 * An entry appended in between is overwritten unless it was appended under the same lock.
 */
function flushInFlight(d: Deps, ref: SessionRef): () => void {
  const release = d.store.lockInbox(ref, d.now());
  if (!release) throw new Error("the inbox lock is taken");
  const read = d.store.queued(ref);
  return () => {
    d.store.saveInbox(ref, read);
    release();
  };
}

const deferred = expect.objectContaining({ lane: "talker", action: "notice-deferred" });

describe("a duty notice written while another process rewrites the queue it goes to", () => {
  test("owed LOST repayment waits for the destination lock, then delivers once", async () => {
    const { w, d, lane, told } = await quietLane();
    rmSync(join(d.store.root, "roles.json"));
    w.panes.delete(lane.paneId);
    await dutyTick(d);
    const owed = join(d.store.root, "duty", "lead.jsonl");
    const kept = readFileSync(owed, "utf8");
    d.store.setRole("lead", href("w1:p1"));
    const finish = flushInFlight(d, href("w1:p1"));
    await dutyTick(d);
    const held = {
      source: existsSync(owed) ? readFileSync(owed, "utf8") : undefined,
      queued: d.store.queued(href("w1:p1")),
      delivered: told("LOST"),
    };
    finish();
    await dutyTick(d);
    expect(told("LOST")).toBe(1);
    expect(held).toEqual({ source: kept, queued: [], delivered: 0 });
    expect(existsSync(owed)).toBe(false);
    expect(existsSync(`${owed}.merging`)).toBe(false);
    expect(d.store.queued(href("w1:p1"))).toEqual([]);
    await dutyTick(d);
    expect(told("LOST")).toBe(1);
  });

  test("a LOST notice for a registered lead during a flush of its inbox: the lane is lost and the lead hears of it once", async () => {
    const { w, d, lane, told } = await quietLane();
    const finish = flushInFlight(d, href("w1:p1"));
    w.panes.delete(lane.paneId);
    expect(await dutyTick(d)).toContainEqual({ lane: "talker", action: "lost" });
    expect(d.store.lane("talker")!.status).toBe("lost");
    finish();
    await dutyTick(d);
    await dutyTick(d);
    expect(told("LOST")).toBe(1);
  });

  test("an escalation due during a flush of the lead's inbox is not marked told; the next pass tells the lead once", async () => {
    const { d, at, told } = await quietLane();
    const finish = flushInFlight(d, href("w1:p1"));
    const first = await at(40);
    const marked = d.store.lane("talker")!.escalatedAt;
    finish();
    await at(41);
    await at(42);
    expect(told("ESCALATE")).toBe(1);
    expect(first).toContainEqual(deferred);
    expect(marked).toBeUndefined();
  });

  test("a nudge due during a flush of the lane's inbox is not counted; the next pass nudges the lane once", async () => {
    const { d, at, lane, pane } = await quietLane();
    const finish = flushInFlight(d, lane.sessionRef);
    const first = await at(10);
    const counted = d.store.lane("talker")!.nudges;
    finish();
    await at(11);
    await at(12);
    expect(pane.received.filter((m) => m.includes("[duty -> talker]"))).toHaveLength(1);
    expect(d.store.lane("talker")!.nudges).toBe(1);
    expect(first).toContainEqual(deferred);
    expect(counted).toBe(0);
  });
});
