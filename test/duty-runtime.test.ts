import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import type { Lane } from "../src/store-types.ts";
import { World, href, sid } from "./fake.ts";

const ID = sid(7);
const lane = (over: Partial<Lane> = {}): Lane => ({
  key: "native-lane",
  sessionRef: href(ID),
  brief: "/b.md",
  cwd: "/w",
  status: "working",
  createdAt: 0,
  lastActivityAt: 0,
  progressAt: 0,
  noticeId: "native-lane-notice",
  progressEpoch: 0,
  nudges: 0,
  log: [],
  ...over,
});

describe("the duty pass on native lanes", () => {
  test("an agent in error waits like a blocked one: never nudged (the lead hears of it at 40 minutes)", async () => {
    const w = new World();
    const d = w.deps();
    const pane = w.addPane(ID, "error");
    d.store.saveLane(lane());
    w.clock = 39 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("native-lane")!.nudges).toBe(0);
    expect(pane.received).toEqual([]);
  });
});
