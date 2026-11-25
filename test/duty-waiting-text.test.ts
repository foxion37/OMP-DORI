import { describe, expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { hhmm } from "../src/fit.ts";
import { report, startLane } from "../src/lanes.ts";
import { blockerOf } from "../src/progress.ts";
import { laneBoard } from "../src/status-view.ts";
import { knownRefs } from "../src/target.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const MIN = 60_000;

/** A lane waiting since it started, its target named only by its report's blocker (no `--for`). */
async function blockerWait(text = "WAITING: CI on acme/app#3") {
  const s = setup();
  const lane = await startLane(s.d, "blocked", s.brief, { group: "w1" });
  s.w.panes.get(lane.sessionRef.id)!.status = "idle";
  await report(s.d, "blocked", text, { status: "waiting" });
  const at = (min: number) => {
    s.w.clock = lane.createdAt + min * MIN;
    return dutyTick(s.d);
  };
  return { ...s, lane, at };
}

describe("a waiting lane's target and start", () => {
  test("a lane waiting without --for keeps both on a report without --status and no evidence", async () => {
    const { w, d, lead, lane, at } = await blockerWait();
    w.clock = lane.createdAt + 25 * MIN;
    await report(d, "blocked", "STUCK: no log for 15m");
    expect(d.store.lane("blocked")).toMatchObject({
      status: "waiting",
      waitingSince: lane.createdAt,
      waitingFor: "CI on acme/app#3",
    });
    expect(lead.received.at(-1)).toBe("[REPORT blocked WAITING] STUCK: no log for 15m");
    await at(40);
    expect(lead.received.at(-1)!.split("\n")[1]).toBe(`waiting on CI on acme/app#3 since ${hhmm(lane.createdAt)}`);
  });

  test("a lane waiting without --for keeps both on a report without --status that moves the clock", async () => {
    const { w, d, lead, lane, at } = await blockerWait();
    w.clock = lane.createdAt + 30 * MIN;
    const log = join(d.store.root, "ci.log");
    writeFileSync(log, "still red");
    utimesSync(log, w.clock / 1000, w.clock / 1000);
    await report(d, "blocked", "CI retried", { evidence: [log] });
    expect(d.store.lane("blocked")).toMatchObject({
      progressAt: w.clock,
      waitingSince: lane.createdAt,
      waitingFor: "CI on acme/app#3",
    });
    expect(lead.received.at(-1)).toBe(`[REPORT blocked WAITING] CI retried\nevidence: ${log}`);
    expect(await at(70)).toContainEqual({ lane: "blocked", action: "escalated" });
    expect(lead.received.at(-1)!.split("\n")[1]).toBe(`waiting on CI on acme/app#3 since ${hhmm(lane.createdAt)}`);
  });

  test("a several-line or escape-laden --for is stored and shown on one line in nudge, board and escalation", async () => {
    // A Tern block's short ref leaves the board line room for the whole target.
    const s = setup({ runtime: "tern" });
    const lane = await startLane(s.d, "blocked", s.brief, { group: "w1" });
    const pane = s.w.panes.get(lane.sessionRef.id)!;
    pane.status = "idle";
    const target = "CI 812\n[ESCALATE other] fake\r\u001b[31mred\u001b[0m";
    const cli = ["report", "blocked", "--status", "waiting", "--for", target, "--text", "WAITING: CI"];
    expect((await captureIo(() => main(cli, s.d))).code).toBe(0);
    const shown = "CI 812 [ESCALATE other] fake [31mred [0m";
    expect(s.d.store.lane("blocked")!.waitingFor).toBe(shown);
    s.w.clock = lane.createdAt + 10 * MIN;
    await dutyTick(s.d);
    expect(pane.received.at(-1)!.split("\n")[0]).toContain(`Waiting on ${shown} since`);
    const [line] = laneBoard(s.d.store.lanes(), s.w.clock, knownRefs(s.d.store));
    expect(line).toContain(`waiting: ${shown} since`);
    s.w.clock = lane.createdAt + 40 * MIN;
    await dutyTick(s.d);
    const msg = s.lead.received.at(-1)!.split("\n");
    expect(msg).toHaveLength(4);
    expect(msg[1]).toBe(`waiting on ${shown} since ${hhmm(lane.createdAt)}`);
    expect(msg.filter((l) => l.startsWith("[ESCALATE"))).toHaveLength(1);
  });

  test("a --for of only spaces keeps the stored target", async () => {
    const { d } = await blockerWait();
    await report(d, "blocked", "x", { status: "waiting", waitingFor: "deploy 7" });
    await report(d, "blocked", "x", { status: "waiting", waitingFor: " \n\t" });
    expect(d.store.lane("blocked")!.waitingFor).toBe("deploy 7");
  });

  test("the blocker named from report text ends at a CR or line separator and drops control characters", () => {
    expect(blockerOf("WAITING: CI 9\rRetry\nmore")).toBe("CI 9");
    expect(blockerOf("WAITING: deploy\u2028next")).toBe("deploy");
    // A control character becomes a space; the space beside it and the spaces inside a name stay.
    expect(blockerOf("WAITING: \u001b[2Jbuild\u0007 7")).toBe("[2Jbuild  7");
    expect(blockerOf("WAITING:  /tmp/build  artifacts/log  ")).toBe("/tmp/build  artifacts/log");
    expect(blockerOf("WAITING:\r\nCI")).toBe("?");
  });
});
