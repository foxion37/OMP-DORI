import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { dutyTick } from "../src/duty.ts";
import { hhmm } from "../src/fit.ts";
import { report, startLane } from "../src/lanes.ts";
import { audit } from "../src/loop-audit.ts";
import { laneBoard } from "../src/status-view.ts";
import type { LoopRun } from "../src/store-types.ts";
import { setup } from "./harness-setup.ts";

const MIN = 60_000;
// A CI job link with no space in it: any prefix of it names no job, and a long lane key leaves a short prefix.
const URL =
  "https://github.com/example-org/example-repo/actions/runs/123456789012/job/987654321098?check_suite_focus=true";

/** A 41-character lane key, its idle pane waiting on `target`; `at(m)` runs one duty pass m minutes after it started. */
async function longWait(target = URL) {
  const s = setup();
  const key = `k${"-long".repeat(8)}`;
  const lane = await startLane(s.d, key, s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.paneId)!;
  pane.status = "idle";
  await report(s.d, key, "WAITING: CI", { status: "waiting", waitingFor: target });
  const at = (min: number) => {
    s.w.clock = lane.createdAt + min * MIN;
    return dutyTick(s.d);
  };
  return { ...s, key, lane, pane, at };
}

const within120 = (lines: readonly string[]) => {
  for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(120);
};

describe("a long waiting target or evidence link", () => {
  test("the nudge keeps its first line short and names the whole target in its body", async () => {
    const { key, lane, pane, at } = await longWait();
    expect(await at(10)).toContainEqual({ lane: key, action: "nudge-1" });
    const lines = pane.received.at(-1)!.split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^\\[duty -> ${key}\\] Waiting on https://\\S*… since ${hhmm(lane.createdAt)};`),
    );
    expect(lines.slice(1)).toContain(`  ${URL}`);
    // The command lines hold the key whole and run past 120 columns; the lines naming the target do not.
    within120(lines.filter((l) => !l.includes("`")));
  });

  test("a target longer than a line, spaces and all, is named whole on one indented line", async () => {
    const target = `${URL} then the deploy of release 2026.11.15-rc3 to the staging cluster eu-west-1`;
    const { pane, at } = await longWait(target);
    await at(10);
    const lines = pane.received.at(-1)!.split("\n");
    const parts = lines.slice(1).filter((l) => l.startsWith("  "));
    expect(parts).toEqual([`  ${target}`]);
    expect(Bun.stringWidth(parts[0]!)).toBeGreaterThan(120);
    // Only that line runs past 120 columns; the terminal folds it, and a copy of it is the whole target.
    within120(lines.filter((l) => !l.includes("`") && l !== `  ${target}`));
  });

  test("the escalation keeps its short waiting line and names the whole target under it", async () => {
    const { key, lane, lead, at } = await longWait();
    expect(await at(40)).toContainEqual({ lane: key, action: "escalated" });
    const lines = lead.received.at(-1)!.split("\n");
    expect(lines[1]).toMatch(new RegExp(`^waiting on https://\\S*… since ${hhmm(lane.createdAt)}$`));
    expect(lines[2]).toBe(`  ${URL}`);
    expect(lines[3]).toStartWith("pane idle, ");
    expect(lines.filter((l) => l.startsWith("[ESCALATE"))).toHaveLength(1);
    within120(lines);
  });

  test("the board keeps the lane on its line and puts the whole target below it when the line cut it", async () => {
    const { d, w, key, lane } = await longWait();
    const lines = laneBoard(d.store.lanes(), w.clock);
    expect(lines[0]).toMatch(new RegExp(`^${key} .* waiting: https://\\S*… since ${hhmm(lane.createdAt)}`));
    expect(lines).toContain(`  ${URL}`);
    within120(lines);
    await report(d, key, "x", { status: "waiting", waitingFor: "CI 812" });
    expect(laneBoard(d.store.lanes(), w.clock)).toHaveLength(1);
  });

  test("the hourly audit names the whole target", async () => {
    const { d, w, key, lane } = await longWait();
    w.clock = lane.createdAt + 4 * 60 * MIN;
    const run: LoopRun = { at: w.clock, synced: [], findings: [], started: [], held: [], asked: [] };
    await audit(d, run);
    expect(run.findings).toEqual([`${key} waiting, no progress for 4h: on ${URL} since ${hhmm(lane.createdAt)}`]);
  });

  test("the escalation names the whole last evidence under its line when the line cut it", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "talker", brief, { group: "w1" });
    w.panes.get(lane.paneId)!.status = "idle";
    await report(d, "talker", "CI is running", { evidence: [URL] });
    w.clock = lane.createdAt + 41 * MIN;
    expect(await dutyTick(d)).toContainEqual({ lane: "talker", action: "escalated" });
    const lines = lead.received.at(-1)!.split("\n");
    expect(lines[2]).toMatch(/^last evidence: …\S+ @ \d\d:\d\d\. Next: check the lane/);
    expect(lines.slice(3)).toEqual([`  ${URL}`]);
    within120(lines);
  });
});

// 200 columns, no space: wider than any line, so a split anywhere leaves no line a reader can copy or click whole.
const WIDE = `https://ci.example.com/org/repo/actions/runs/123456789012/job/987654321098?${"step=build-and-test&".repeat(6)}attempt=1`;
const whole = `  ${WIDE}`;

describe("a link wider than a line", () => {
  test("is named whole on one line in the nudge, the escalation, the board and the hourly audit", async () => {
    expect(Bun.stringWidth(WIDE)).toBeGreaterThanOrEqual(200);
    const { d, w, key, lane, pane, lead, at } = await longWait(WIDE);
    await at(10);
    expect(pane.received.at(-1)!.split("\n")).toContain(whole);
    expect(laneBoard(d.store.lanes(), w.clock)).toContain(whole);
    expect(await at(40)).toContainEqual({ lane: key, action: "escalated" });
    expect(lead.received.at(-1)!.split("\n")[2]).toBe(whole);
    w.clock = lane.createdAt + 4 * 60 * MIN;
    const run: LoopRun = { at: w.clock, synced: [], findings: [], started: [], held: [], asked: [] };
    await audit(d, run);
    expect(run.findings[0]).toContain(` on ${WIDE} since `);
  });

  test("is named whole on one line under the escalation's last evidence", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "talker", brief, { group: "w1" });
    w.panes.get(lane.paneId)!.status = "idle";
    await report(d, "talker", "CI is running", { evidence: [WIDE] });
    w.clock = lane.createdAt + 41 * MIN;
    expect(await dutyTick(d)).toContainEqual({ lane: "talker", action: "escalated" });
    expect(lead.received.at(-1)!.split("\n").slice(3)).toEqual([whole]);
  });
});

describe("a path with spaces wider than a line", () => {
  // A space inside a path is not a place to break it: either half names no file a reader can open.
  const spaced = (root: string) => join(root, "build artifacts", `${"nightly run ".repeat(8)}end`, "result log.txt");

  test("is named whole on one line in the nudge, the escalation and the board", async () => {
    const target = spaced("/srv/ci");
    expect(Bun.stringWidth(target)).toBeGreaterThan(120);
    const { d, w, key, pane, lead, at } = await longWait(target);
    await at(10);
    expect(pane.received.at(-1)!.split("\n")).toContain(`  ${target}`);
    expect(laneBoard(d.store.lanes(), w.clock)).toContain(`  ${target}`);
    expect(await at(40)).toContainEqual({ lane: key, action: "escalated" });
    expect(lead.received.at(-1)!.split("\n")[2]).toBe(`  ${target}`);
  });

  test("is named whole on one line under the escalation's last evidence", async () => {
    const { w, d, lead, brief } = setup();
    const file = spaced(d.store.root);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "ok");
    const lane = await startLane(d, "talker", brief, { group: "w1" });
    w.panes.get(lane.paneId)!.status = "idle";
    w.clock = lane.createdAt + MIN;
    await report(d, "talker", "built", { evidence: [file] });
    expect(d.store.lane("talker")!.lastEvidence?.ref).toBe(file);
    w.clock = lane.createdAt + 42 * MIN;
    expect(await dutyTick(d)).toContainEqual({ lane: "talker", action: "escalated" });
    expect(lead.received.at(-1)!.split("\n").slice(3)).toEqual([`  ${file}`]);
  });
});

describe("a prompts directory whose nudge-waiting.md predates {{wholeTarget}}", () => {
  // The template an older dori shipped: the target only in its first line and its check line, both cut to fit.
  const OLD = [
    "[duty -> {{key}}] Waiting on {{target}} since {{waitingSince}}; no new evidence for {{age}}.",
    "- Check that {{target}} is still alive and moving (a check, a process, a request).",
  ].join("\n");

  test("still names the whole target, under the line that cut it", async () => {
    const { d, key, lane, pane, at } = await longWait();
    const own = join(d.store.root, "own-prompts");
    mkdirSync(own);
    writeFileSync(join(own, "nudge-waiting.md"), OLD);
    const previous = process.env["DORI_PROMPTS_DIR"];
    process.env["DORI_PROMPTS_DIR"] = own;
    try {
      expect(await at(10)).toContainEqual({ lane: key, action: "nudge-1" });
    } finally {
      if (previous === undefined) delete process.env["DORI_PROMPTS_DIR"];
      else process.env["DORI_PROMPTS_DIR"] = previous;
    }
    const lines = pane.received.at(-1)!.split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^\\[duty -> ${key}\\] Waiting on https://\\S*… since ${hhmm(lane.createdAt)};`),
    );
    expect(lines[1]).toBe(`  ${URL}`);
    expect(lines[2]).toStartWith("- Check that https://");
    expect(lines).toHaveLength(3);
  });
});

describe("a name with runs of spaces", () => {
  // `build  artifacts` is not `build artifacts`: a name shown whole keeps every printable space it has.
  const doubled = (root: string) =>
    join(root, "build  artifacts", `${"nightly   run ".repeat(6)}end`, "result  log.txt");

  test("an evidence file keeps them in PROGRESS, the lead's report and the escalation", async () => {
    const { w, d, lead, brief } = setup();
    const file = doubled(d.store.root);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "ok");
    const lane = await startLane(d, "talker", brief, { group: "w1" });
    w.panes.get(lane.paneId)!.status = "idle";
    w.clock = lane.createdAt + MIN;
    const { progress } = await report(d, "talker", "built", { evidence: [file] });
    expect(progress[0]).toEndWith(`end${sep}result  log.txt`);
    expect(lead.received.at(-1)).toEndWith(`\nevidence: ${file}`);
    w.clock = lane.createdAt + 42 * MIN;
    expect(await dutyTick(d)).toContainEqual({ lane: "talker", action: "escalated" });
    expect(lead.received.at(-1)!.split("\n").slice(3)).toEqual([`  ${file}`]);
  });

  test("a waiting target keeps them in the nudge, the board, the escalation and the hourly audit", async () => {
    const target = doubled("/srv/ci");
    const { d, w, key, lane, pane, lead, at } = await longWait(target);
    await at(10);
    expect(pane.received.at(-1)!.split("\n")).toContain(`  ${target}`);
    expect(laneBoard(d.store.lanes(), w.clock)).toContain(`  ${target}`);
    expect(await at(40)).toContainEqual({ lane: key, action: "escalated" });
    expect(lead.received.at(-1)!.split("\n")[2]).toBe(`  ${target}`);
    w.clock = lane.createdAt + 4 * 60 * MIN;
    const run: LoopRun = { at: w.clock, synced: [], findings: [], started: [], held: [], asked: [] };
    await audit(d, run);
    expect(run.findings[0]).toContain(` on ${target} since `);
  });

  test("a target from the report's WAITING line keeps them; a tab or an escape still becomes one space", async () => {
    const { d, brief } = setup();
    await startLane(d, "waiter", brief, { group: "w1" });
    await report(d, "waiter", `WAITING: ${doubled("/srv")}\nmore`, { status: "waiting" });
    expect(d.store.lane("waiter")!.waitingFor).toBe(doubled("/srv"));
    await report(d, "waiter", "still", { status: "waiting", waitingFor: " job\t42  on\u001b[2Jci " });
    expect(d.store.lane("waiter")!.waitingFor).toBe("job 42  on [2Jci");
  });
});
