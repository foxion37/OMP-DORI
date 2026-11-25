import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import { startLane } from "../src/lanes.ts";
import { World, tref } from "./fake.ts";

const MIN = 60_000;
/**
 * The lead's block in every harness test world: a hand-registered Tern role (`cataly harness role lead`), since a native
 * lead is owned only through `cataly harness up` and its inventory. Lanes open on the fake headless runtime, or on the
 * fake Tern runtime with `runtime: "tern"`.
 */
export const LEAD = "1";
export const LEAD_REF = tref(LEAD);

export function setup(opts: { readonly runtime?: "headless" | "tern" } = {}) {
  const w = new World();
  const d = w.deps(opts);
  const lead = w.addTerminal(LEAD, "idle");
  d.store.setRole("lead", LEAD_REF);
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}

/**
 * A lane in an idle session, with the lead's messages so far cleared. `at(min)` runs a duty pass `min` minutes after
 * the lane started; `told(tag)` counts the lead's `[tag talker]` messages, inside batches too (a busy lead gets queued
 * messages as one numbered message).
 */
export async function quietLane() {
  const s = setup();
  const lane = await startLane(s.d, "talker", s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.sessionRef.id)!;
  pane.status = "idle";
  s.lead.received.length = 0;
  const at = async (min: number) => {
    s.w.clock = lane.createdAt + min * MIN;
    return dutyTick(s.d);
  };
  const told = (tag: string) => s.lead.received.join("\n").split(`[${tag} talker]`).length - 1;
  return { ...s, lane, pane, at, told };
}
