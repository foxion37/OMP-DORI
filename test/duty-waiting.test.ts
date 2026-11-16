import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { hhmm } from "../src/fit.ts";
import { report, startLane } from "../src/lanes.ts";
import { laneBoard } from "../src/status-view.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const MIN = 60_000;

/** A lane whose idle pane has just reported `text` as waiting; `at(m)` runs one duty pass m minutes after it started. */
async function waitingLane(opts: { waitingFor?: string } = {}, text = "WAITING: CI on acme/app#3") {
  const s = setup();
  const lane = await startLane(s.d, "blocked", s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.paneId)!;
  pane.status = "idle";
  await report(s.d, "blocked", text, { status: "waiting", ...opts });
  const at = async (min: number) => {
    s.w.clock = lane.createdAt + min * MIN;
    return dutyTick(s.d);
  };
  return { ...s, lane, pane, at };
}

describe("a waiting lane", () => {
  test("is nudged to check what it waits on, then escalated at 40 minutes with the target named", async () => {
    const { lane, pane, lead, at } = await waitingLane({ waitingFor: "CI run 812" });
    const start = hhmm(lane.createdAt);
    expect(await at(9)).toEqual([]);
    expect(await at(10)).toContainEqual({ lane: "blocked", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain(`[duty -> blocked] Waiting on CI run 812 since ${start}`);
    expect(pane.received.at(-1)).toContain(
      "is still alive and moving (a check, a process, a request):\n  CI run 812\n",
    );
    expect(await at(20)).toContainEqual({ lane: "blocked", action: "nudge-2" });
    expect((await at(39)).map((e) => e.action)).not.toContain("escalated");
    expect(await at(40)).toContainEqual({ lane: "blocked", action: "escalated" });
    const msg = lead.received.at(-1)!;
    expect(msg.split("\n")[0]).toContain("[ESCALATE blocked WAITING] no new evidence for 40m");
    expect(msg.split("\n")[1]).toBe(`waiting on CI run 812 since ${start}`);
    expect(msg.split("\n")[2]).toBe("pane idle, 2 nudges, 0 reports without evidence");
    expect(msg).toContain("Next: check it is alive, or reassign the lane.");
    for (const line of msg.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
    expect((await at(300)).map((e) => e.action)).not.toContain("escalated");
  });

  test("without --for names the blocker from its report text, cut to 40 columns", async () => {
    const { lead, at } = await waitingLane();
    await at(40);
    expect(lead.received.at(-1)!.split("\n")[1]).toMatch(/^waiting on CI on acme\/app#3 since \d\d:\d\d$/);
    const wide = await waitingLane({}, `WAITING: ${"ｗｉｄｅ ".repeat(12)}\nmore`);
    await wide.at(10);
    const nudge = wide.pane.received.at(-1)!;
    expect(nudge).toContain(`Waiting on ${"ｗｉｄｅ ".repeat(4)}ｗ… since`);
    for (const line of nudge.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
  });

  test("repeating WAITING keeps its target and start time and does not reset the clock; new evidence does", async () => {
    const { w, d, lane, at } = await waitingLane({ waitingFor: "CI" });
    w.clock = lane.createdAt + 25 * MIN;
    await report(d, "blocked", "STUCK: no log for 15m", { status: "waiting" });
    expect(d.store.lane("blocked")).toMatchObject({ waitingSince: lane.createdAt, waitingFor: "CI" });
    await report(d, "blocked", "now on deploy", { status: "waiting", waitingFor: "deploy 7" });
    expect(d.store.lane("blocked")).toMatchObject({ waitingSince: lane.createdAt, waitingFor: "deploy 7" });
    expect(await at(40)).toContainEqual({ lane: "blocked", action: "escalated" });
    w.clock = lane.createdAt + 45 * MIN;
    const log = join(d.store.root, "ci.log");
    writeFileSync(log, "green");
    utimesSync(log, w.clock / 1000, w.clock / 1000);
    await report(d, "blocked", "CI moved", { status: "waiting", evidence: [log] });
    expect(d.store.lane("blocked")).toMatchObject({ progressAt: w.clock, nudges: 0, waitingSince: lane.createdAt });
    expect((await at(84)).map((e) => e.action)).not.toContain("escalated");
    expect(await at(85)).toContainEqual({ lane: "blocked", action: "escalated" });
  });

  test("going back to working clears the target", async () => {
    const { d, lead } = await waitingLane({ waitingFor: "CI" });
    await report(d, "blocked", "CI green, back on it", { status: "working" });
    const lane = d.store.lane("blocked")!;
    expect(lane.status).toBe("working");
    expect(lane.waitingFor).toBeUndefined();
    expect(lane.waitingSince).toBeUndefined();
    expect(lead.received.at(-1)).toBe("[REPORT blocked] CI green, back on it");
  });

  test("a record from before --for waits since its last progress", async () => {
    const { d, lead, lane, at } = await waitingLane();
    const old = d.store.lane("blocked")!;
    delete old.waitingFor;
    delete old.waitingSince;
    d.store.saveLane(old);
    await at(40);
    expect(lead.received.at(-1)!.split("\n")[1]).toBe(`waiting on CI on acme/app#3 since ${hhmm(lane.createdAt)}`);
  });

  test("a record from before --for keeps its inferred start and target when it reports again before escalation", async () => {
    const { w, d, lead, lane, at } = await waitingLane();
    const old = d.store.lane("blocked")!;
    delete old.waitingFor;
    delete old.waitingSince;
    d.store.saveLane(old);
    w.clock = lane.createdAt + 25 * MIN;
    await report(d, "blocked", "STUCK: no log for 15m", { status: "waiting" });
    expect(d.store.lane("blocked")).toMatchObject({ waitingSince: lane.createdAt, waitingFor: "CI on acme/app#3" });
    w.clock = lane.createdAt + 30 * MIN;
    const log = join(d.store.root, "ci.log");
    writeFileSync(log, "still red");
    utimesSync(log, w.clock / 1000, w.clock / 1000);
    await report(d, "blocked", "CI retried", { status: "waiting", evidence: [log] });
    expect(d.store.lane("blocked")).toMatchObject({ waitingSince: lane.createdAt, progressAt: w.clock });
    expect(await at(70)).toContainEqual({ lane: "blocked", action: "escalated" });
    expect(lead.received.at(-1)!.split("\n")[1]).toBe(`waiting on CI on acme/app#3 since ${hhmm(lane.createdAt)}`);
  });

  test("the status line names what it waits on and since when, within 120 columns, the time kept on a long target", async () => {
    const { w, d, lane } = await waitingLane({ waitingFor: "CI 812" });
    const since = hhmm(lane.createdAt);
    const [line] = laneBoard(d.store.lanes(), w.clock);
    expect(line).toContain(`waiting: CI 812 since ${since} | report`);
    expect(Bun.stringWidth(line!)).toBeLessThanOrEqual(120);
    await report(d, "blocked", "x", { status: "waiting", waitingFor: "ＬＯＮＧ ＴＡＲＧＥＴ ".repeat(8) });
    const [long] = laneBoard(d.store.lanes(), w.clock);
    expect(long).toMatch(new RegExp(`waiting: ＬＯＮＧ .*… since ${since}`));
    expect(Bun.stringWidth(long!)).toBeLessThanOrEqual(120);
  });

  test("dori report takes --for only with --status waiting", async () => {
    const { d } = await waitingLane();
    const ok = await captureIo(() =>
      main(["report", "blocked", "--status", "waiting", "--for", "deploy 7", "--text", "WAITING: deploy"], d),
    );
    expect(ok.code).toBe(0);
    expect(d.store.lane("blocked")!.waitingFor).toBe("deploy 7");
    await expect(main(["report", "blocked", "--for", "deploy 7", "--text", "x"], d)).rejects.toThrow(
      "--for needs --status waiting",
    );
  });

  test("a waiting lane's blocked or working pane is escalated but never nudged", async () => {
    const { pane, at } = await waitingLane({ waitingFor: "CI" });
    pane.status = "blocked";
    expect((await at(20)).map((e) => e.action)).toEqual([]);
    expect(await at(40)).toContainEqual({ lane: "blocked", action: "escalated" });
    expect(pane.received.filter((m) => m.startsWith("[duty"))).toEqual([]);
  });

  test.each(["link", "wide text"])(
    "a legacy custom template preserves a clipped %s without wholeTarget",
    async (kind) => {
      const target =
        kind === "link" ? `https://ci.example.test/jobs/${"1".repeat(160)}` : "ＷＩＤＥ ＴＡＲＧＥＴ ".repeat(8).trim();
      const { d, lane, pane, at } = await waitingLane({ waitingFor: target });
      const dir = join(d.store.root, "custom-prompts");
      mkdirSync(dir);
      writeFileSync(
        join(dir, "nudge-waiting.md"),
        "[custom {{key}}] Waiting on {{target}} since {{waitingSince}}\nCheck {{target}}.",
      );
      const previous = process.env["DORI_PROMPTS_DIR"];
      process.env["DORI_PROMPTS_DIR"] = dir;
      try {
        expect(await at(10)).toContainEqual({ lane: "blocked", action: "nudge-1" });
        const lines = pane.received.at(-1)!.split("\n");
        expect(lines[0]).toContain(`… since ${hhmm(lane.createdAt)}`);
        expect(Bun.stringWidth(lines[0]!)).toBeLessThanOrEqual(120);
        expect(lines.slice(1)).toEqual([`  ${target}`, expect.stringMatching(/^Check .*…\.$/)]);
        expect(lines.filter((line) => Bun.stringWidth(line) > 120)).toEqual([`  ${target}`]);
        expect(await at(11)).toEqual([]);
        expect(pane.received.filter((text) => text.startsWith("[custom blocked]"))).toHaveLength(1);
        expect(d.store.lane("blocked")).toMatchObject({
          nudges: 1,
          progressAt: lane.createdAt,
          waitingSince: lane.createdAt,
          waitingFor: target,
        });
      } finally {
        if (previous === undefined) delete process.env["DORI_PROMPTS_DIR"];
        else process.env["DORI_PROMPTS_DIR"] = previous;
      }
    },
  );

  test.each(["missing", "directory"])(
    "a %s waiting override uses the default or errors without consuming a nudge, then can be repaired",
    async (kind) => {
      const { d, lane, pane, at } = await waitingLane({ waitingFor: "CI" });
      const dir = join(d.store.root, "custom-prompts");
      const path = join(dir, "nudge-waiting.md");
      mkdirSync(dir);
      if (kind === "directory") mkdirSync(path);
      const before = d.store.lane("blocked");
      const previous = process.env["DORI_PROMPTS_DIR"];
      process.env["DORI_PROMPTS_DIR"] = dir;
      try {
        if (kind === "missing") {
          expect(await at(10)).toContainEqual({ lane: "blocked", action: "nudge-1" });
          expect(pane.received.at(-1)).toContain(`[duty -> blocked] Waiting on CI since ${hhmm(lane.createdAt)}`);
          expect(await at(11)).toEqual([]);
          expect(pane.received.filter((text) => text.startsWith("[duty -> blocked]"))).toHaveLength(1);
        } else {
          expect(await at(10)).toEqual([
            expect.objectContaining({ lane: "blocked", action: "lane-failed", detail: expect.any(String) }),
          ]);
          expect(d.store.lane("blocked")).toEqual(before);
          expect(pane.received.filter((text) => text.startsWith("[duty -> blocked]"))).toEqual([]);
          rmSync(path, { recursive: true });
          writeFileSync(path, "custom waiting check {{key}}: {{target}} since {{waitingSince}}");
          expect(await at(10)).toContainEqual({ lane: "blocked", action: "nudge-1" });
          expect(pane.received.at(-1)).toBe(`custom waiting check blocked: CI since ${hhmm(lane.createdAt)}`);
        }
        expect(d.store.lane("blocked")!.nudges).toBe(1);
        expect(d.store.lane("blocked")!.log.filter((entry) => entry.kind === "nudge")).toHaveLength(1);
      } finally {
        if (previous === undefined) delete process.env["DORI_PROMPTS_DIR"];
        else process.env["DORI_PROMPTS_DIR"] = previous;
      }
    },
  );
});
