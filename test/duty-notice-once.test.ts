import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { hooksSettled } from "../src/hooks.ts";
import { readQueue } from "../src/inbox-files.ts";
import { startLane } from "../src/lanes.ts";
import { href } from "./fake.ts";
import { quietLane } from "./harness-setup.ts";

const MIN = 60_000;

/**
 * The process dies at the next call of `method`, once: what that call would have written is not written. "queue" is
 * the next write to an inbox, whichever store method makes it.
 */
function dieOnce(d: Deps, method: "saveLane" | "queue"): void {
  const names = method === "queue" ? (["enqueue", "enqueueOnce"] as const) : ([method] as const);
  let armed = true;
  for (const name of names) {
    const real = (d.store as unknown as Record<string, ((...a: never[]) => unknown) | undefined>)[name]?.bind(d.store);
    if (!real) continue;
    Object.assign(d.store, {
      [name]: (...a: never[]) => {
        if (armed) {
          armed = false;
          throw new Error(`killed at ${name}`);
        }
        return real(...a);
      },
    });
  }
}

describe("duty notices survive queue and settlement retries", () => {
  test("killed between queueing the escalation and marking the lane: the next pass marks it without queueing it again", async () => {
    const { d, at, told, lead } = await quietLane();
    lead.status = "working";
    dieOnce(d, "saveLane");
    expect((await at(40)).map((e) => e.action)).toContain("lane-failed");
    expect(d.store.lane("talker")!.escalatedAt).toBeUndefined();
    await at(41);
    expect(d.store.queued(href("w1:p1"))).toHaveLength(1);
    expect(d.store.lane("talker")!.escalatedAt).toBe(d.now());
    lead.status = "idle";
    await at(42);
    await at(43);
    expect(told("ESCALATE")).toBe(1);
  });

  test("killed before the escalation's flush: the next pass delivers it first and does not queue it again", async () => {
    const { d, at, told } = await quietLane();
    dieOnce(d, "saveLane");
    await at(40);
    expect(told("ESCALATE")).toBe(0);
    expect(await at(41)).toContainEqual({ pane: "w1:p1", action: "flushed" });
    await at(42);
    expect(told("ESCALATE")).toBe(1);
    expect(d.store.lane("talker")!.log.filter((e) => e.kind === "escalate")).toHaveLength(1);
  });

  test("killed before or after queueing the LOST notice: the lane is marked lost and the lead hears of it once", async () => {
    const { w, d, lane, told } = await quietLane();
    w.panes.delete(lane.paneId);
    dieOnce(d, "queue");
    await dutyTick(d);
    dieOnce(d, "saveLane");
    await dutyTick(d);
    await dutyTick(d);
    await dutyTick(d);
    expect(told("LOST")).toBe(1);
    expect(d.store.lane("talker")!.status).toBe("lost");
  });

  test("a lane lost with no lead registered is marked lost and its hook runs; the lead hears of it once one is", async () => {
    const { w, d, lane, told } = await quietLane();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ hooks: { onLost: ["my-hook", "{key}"] } }));
    rmSync(join(d.store.root, "roles.json"));
    w.panes.delete(lane.paneId);
    const first = await dutyTick(d);
    expect(first).toContainEqual({ lane: "talker", action: "lost" });
    expect(first).toContainEqual(expect.objectContaining({ lane: "talker", action: "lost-no-lead" }));
    expect(d.store.lane("talker")!.status).toBe("lost");
    await hooksSettled();
    const hooked = () => w.calls.filter((c) => c.cmd === "my-hook").map((c) => c.argv);
    expect(hooked()).toEqual([["talker"]]);
    d.store.setRole("lead", href("w1:p1"));
    await dutyTick(d);
    await dutyTick(d);
    await hooksSettled();
    expect(told("LOST")).toBe(1);
    expect(hooked()).toEqual([["talker"]]);
  });

  test("a lane lost with no lead and started again under the same key: the lead still hears of the loss, once", async () => {
    const { w, d, lane, brief, told } = await quietLane();
    rmSync(join(d.store.root, "roles.json"));
    w.panes.delete(lane.paneId);
    await dutyTick(d);
    expect(d.store.lane("talker")!.status).toBe("lost");
    // The new record replaces the lost one before any lead is registered.
    w.clock += MIN;
    const again = await startLane(d, "talker", brief, { group: "w1" });
    expect(again.createdAt).not.toBe(lane.createdAt);
    await dutyTick(d);
    d.store.setRole("lead", href("w1:p1"));
    await dutyTick(d);
    await dutyTick(d);
    expect(told("LOST")).toBe(1);
  });

  test("a move of the kept notices into the lead's inbox cut short after its append: the next pass adds none twice", async () => {
    const { w, d, lane, told } = await quietLane();
    rmSync(join(d.store.root, "roles.json"));
    w.panes.delete(lane.paneId);
    await dutyTick(d);
    // The move appended the kept notice to the lead's inbox and stopped before removing the copy it renamed aside.
    const kept = join(d.store.root, "duty", "lead.jsonl");
    renameSync(kept, `${kept}.merging`);
    d.store.setRole("lead", href("w1:p1"));
    for (const m of readQueue(`${kept}.merging`)) await d.store.enqueue(href("w1:p1"), m, false);
    await dutyTick(d);
    await dutyTick(d);
    expect(told("LOST")).toBe(1);
    expect(existsSync(`${kept}.merging`)).toBe(false);
  });

  test("killed between recording a delivered notice's id and rewriting its queue: the next flush does not resend it", async () => {
    const { d, at, told } = await quietLane();
    // The process dies inside the rewrite of the lead's inbox: the delivered ids are recorded, the queue is not rewritten.
    const real = d.store.saveInbox.bind(d.store);
    d.store.saveInbox = (ref, _msgs, gone = []) => {
      d.store.saveInbox = real;
      real(ref, readQueue(d.store.inboxPath(ref)), gone);
      throw new Error("killed inside saveInbox");
    };
    expect((await at(40)).map((e) => e.action)).toContain("lane-failed");
    expect(told("ESCALATE")).toBe(1);
    await at(41);
    await at(42);
    expect(told("ESCALATE")).toBe(1);
    expect(d.store.queued(href("w1:p1"))).toEqual([]);
  });

  test("killed before or after queueing a nudge: the lane gets it once and it is counted once", async () => {
    const { d, at, pane } = await quietLane();
    dieOnce(d, "queue");
    await at(10);
    expect(d.store.lane("talker")!.nudges).toBe(0);
    dieOnce(d, "saveLane");
    await at(11);
    await at(12);
    await at(13);
    expect(pane.received.filter((m) => m.includes("[duty -> talker]"))).toHaveLength(1);
    expect(d.store.lane("talker")!.nudges).toBe(1);
  });

  test("a nudge whose text cannot be read is not counted", async () => {
    const { d, at, pane } = await quietLane();
    const dir = join(d.store.root, "own-prompts");
    mkdirSync(join(dir, "nudge.md"), { recursive: true });
    process.env["DORI_PROMPTS_DIR"] = dir;
    try {
      expect((await at(10)).map((e) => e.action)).toContain("lane-failed");
    } finally {
      delete process.env["DORI_PROMPTS_DIR"];
    }
    expect(d.store.lane("talker")!.nudges).toBe(0);
    expect(pane.received.filter((m) => m.includes("[duty -> talker]"))).toEqual([]);
  });
});
