import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import { hhmm } from "../src/fit.ts";
import { report, startLane } from "../src/lanes.ts";
import { laneBoard } from "../src/status-view.ts";
import { setup } from "./harness-setup.ts";

const MIN = 60_000;
const PROMPTS = join(import.meta.dir, "..", "prompts");

afterEach(() => {
  delete process.env["DORI_PROMPTS_DIR"];
});

describe("a waiting lane after an upgrade", () => {
  test("a prompts directory made before nudge-waiting.md existed still nudges a waiting lane, counted once sent", async () => {
    const s = setup();
    const lane = await startLane(s.d, "blocked", s.brief, { group: "w1" });
    const pane = s.w.panes.get(lane.paneId)!;
    pane.status = "idle";
    await report(s.d, "blocked", "WAITING: CI", { status: "waiting", waitingFor: "CI run 812" });
    // The user's own prompts as an older dori shipped them: every template but nudge-waiting.md.
    const own = join(s.d.store.root, "own-prompts");
    mkdirSync(own, { recursive: true });
    for (const f of readdirSync(PROMPTS).filter((f) => f !== "nudge-waiting.md"))
      writeFileSync(join(own, f), readFileSync(join(PROMPTS, f), "utf8"));
    process.env["DORI_PROMPTS_DIR"] = own;
    s.w.clock = lane.createdAt + 10 * MIN;
    expect(await dutyTick(s.d)).toContainEqual({ lane: "blocked", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain(`[duty -> blocked] Waiting on CI run 812 since ${hhmm(lane.createdAt)}`);
    expect(s.d.store.lane("blocked")!.nudges).toBe(1);
  });

  // The nudge's first line holds the key whole; the target gets what is left of 120 columns, so the time still shows.
  test("a waiting nudge for a 41-character key and a long target keeps its first line within 120 columns", async () => {
    const s = setup();
    const key = `k${"-long".repeat(8)}`;
    expect(key).toHaveLength(41);
    const lane = await startLane(s.d, key, s.brief, { group: "w1" });
    const pane = s.w.panes.get(lane.paneId)!;
    pane.status = "idle";
    await report(s.d, key, "x", {
      status: "waiting",
      waitingFor: "the release build on the shared runner, then deploy",
    });
    s.w.clock = lane.createdAt + 10 * MIN;
    expect(await dutyTick(s.d)).toContainEqual({ lane: key, action: "nudge-1" });
    const first = pane.received.at(-1)!.split("\n")[0]!;
    expect(first).toMatch(
      new RegExp(`^\\[duty -> ${key}\\] Waiting on the release build\\S* .*… since ${hhmm(lane.createdAt)};`),
    );
    expect(Bun.stringWidth(first)).toBeLessThanOrEqual(120);
  });

  // A key and a ref together 55 to 61 columns wide leave the waiting text just under what it needs beside them.
  test("a waiting lane beside a long key and ref keeps `since HH:MM` whole, on a line of its own if need be", async () => {
    const s = setup();
    const key = `k${"-long".repeat(8)}`;
    const lane = await startLane(s.d, key, s.brief, { group: "w1" });
    await report(s.d, key, "x", { status: "waiting", waitingFor: "the release build on the shared runner" });
    for (const width of [55, 58, 61]) {
      const id = `${"w".repeat(width - key.length - 3)}:p3`;
      const lanes = s.d.store.lanes().map((l) => ({ ...l, sessionRef: { ...l.sessionRef, id } }));
      const lines = laneBoard(lanes, s.w.clock);
      const wait = lines.find((l) => l.includes("waiting: "));
      expect(wait).toMatch(new RegExp(`waiting: \\S.* since ${hhmm(lane.createdAt)}( \\| .*)?$`));
      for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(120);
    }
  });
});
