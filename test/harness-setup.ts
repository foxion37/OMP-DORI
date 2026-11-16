import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import { startLane } from "../src/lanes.ts";
import { World, href } from "./fake.ts";

const MIN = 60_000;

export function setup(opts: { runtime?: "herdr" | "hc" } = {}) {
  const w = new World();
  const d = w.deps(opts);
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", href("w1:p1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}

/**
 * A lane in an idle pane, with the lead's messages so far cleared. `at(min)` runs a duty pass `min` minutes after the
 * lane started; `told(tag)` counts the lead's `[tag talker]` messages, inside batches too (a busy lead gets queued
 * messages as one numbered message).
 */
export async function quietLane() {
  const s = setup();
  const lane = await startLane(s.d, "talker", s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.paneId)!;
  pane.status = "idle";
  s.lead.received.length = 0;
  const at = async (min: number) => {
    s.w.clock = lane.createdAt + min * MIN;
    return dutyTick(s.d);
  };
  const told = (tag: string) => s.lead.received.join("\n").split(`[${tag} talker]`).length - 1;
  return { ...s, lane, pane, at, told };
}
