import { describe, expect, test } from "bun:test";
import { utimesSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { oneName } from "../src/fit.ts";
import { ready, report, startLane } from "../src/lanes.ts";
import { href } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const MIN = 60_000;

/** A file whose mtime is the fake clock's now, as if the lane had just written it. */
function touched(dir: string, name: string, at: number): string {
  const path = join(dir, name);
  writeFileSync(path, name);
  utimesSync(path, at / 1000, at / 1000);
  return path;
}

async function quietLane() {
  const s = setup();
  const lane = await startLane(s.d, "talker", s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.paneId)!;
  pane.status = "idle";
  const at = async (min: number) => {
    s.w.clock = lane.createdAt + min * MIN;
    return dutyTick(s.d);
  };
  return { ...s, lane, pane, at };
}

describe("the progress clock", () => {
  test("reports without evidence do not reset it: a chatty lane is escalated at 40 minutes all the same", async () => {
    const { w, d, lead, at, pane } = await quietLane();
    expect(await at(10)).toContainEqual({ lane: "talker", action: "nudge-1" });
    w.clock += 5 * MIN;
    await report(d, "talker", "still checking");
    expect(d.store.lane("talker")).toMatchObject({ nudges: 1 });
    expect(await at(25)).toEqual([]);
    expect(await at(35)).toContainEqual({ lane: "talker", action: "nudge-2" });
    expect(pane.received.at(-1)).toContain("No new evidence since");
    await report(d, "talker", "almost there");
    expect(await at(40)).toContainEqual({ lane: "talker", action: "escalated" });
    const msg = lead.received.at(-1)!;
    expect(msg).toContain("[ESCALATE talker] no new evidence for 40m");
    expect(msg).toContain("pane idle, 2 nudges, 2 reports without evidence");
    expect(Bun.stringWidth(msg.split("\n")[0]!)).toBeLessThanOrEqual(120);
    expect(d.store.lane("talker")!.log.at(-1)).toMatchObject({ kind: "escalate" });
    expect(await at(41)).toEqual([]);
    expect(await at(300)).toEqual([]);
  });

  test("a working pane is escalated too: busy is not progress", async () => {
    const { lead, at, pane } = await quietLane();
    pane.status = "working";
    expect(await at(39)).toEqual([]);
    expect(await at(40)).toContainEqual({ lane: "talker", action: "escalated" });
    expect(lead.received.at(-1)).toContain("pane working, 0 nudges");
  });

  test("new evidence resets the clock and the nudges; the next stall is escalated again", async () => {
    const { w, d, lead, at } = await quietLane();
    await at(10);
    await at(20);
    expect(d.store.lane("talker")!.nudges).toBe(2);
    const file = touched(d.store.root, "draft.md", w.clock);
    await report(d, "talker", "draft written", { evidence: [file] });
    expect(d.store.lane("talker")).toMatchObject({ nudges: 0, progressAt: w.clock, lastEvidence: { ref: file } });
    expect((await at(59)).map((e) => e.action)).not.toContain("escalated");
    expect(await at(60)).toContainEqual({ lane: "talker", action: "escalated" });
    expect(lead.received.at(-1)).toContain("draft.md @");
    await report(d, "talker", "PR up", { evidence: ["https://github.com/acme/app/pull/9"] });
    expect((await at(99)).map((e) => e.action)).not.toContain("escalated");
    expect(await at(100)).toContainEqual({ lane: "talker", action: "escalated" });
  });

  test("old files and links already reported are not progress", async () => {
    const { w, d } = await quietLane();
    const old = touched(d.store.root, "old.md", w.clock - MIN);
    await report(d, "talker", "PR", { evidence: ["acme/app#9"] });
    const after = d.store.lane("talker")!.progressAt;
    w.clock += 5 * MIN;
    await report(d, "talker", "same PR, old file", { evidence: ["acme/app#9", old, "/no/such/file"] });
    expect(d.store.lane("talker")!.progressAt).toBe(after!);
    await ready(d, "talker", "done", ["acme/app#9"]);
    expect(d.store.lane("talker")!.progressAt).toBe(w.clock);
  });

  test("a record from before the clock counts its last report", async () => {
    const { d, lane, at } = await quietLane();
    const old = d.store.lane("talker")!;
    delete old.progressAt;
    old.log.push({ at: lane.createdAt + 30 * MIN, kind: "report", text: "old report" });
    d.store.saveLane(old);
    expect((await at(69)).map((e) => e.action)).not.toContain("escalated");
    expect(await at(70)).toContainEqual({ lane: "talker", action: "escalated" });
  });

  test("a record from before the clock is not moved by a report without evidence, so repeating it cannot dodge escalation", async () => {
    const { w, d, lane, at } = await quietLane();
    const old = d.store.lane("talker")!;
    delete old.progressAt;
    d.store.saveLane(old);
    for (const min of [15, 30, 39]) {
      w.clock = lane.createdAt + min * MIN;
      await report(d, "talker", `still going ${min}`);
      expect(d.store.lane("talker")!.progressAt).toBe(lane.createdAt);
    }
    expect(await at(40)).toContainEqual({ lane: "talker", action: "escalated" });
  });

  test("an escalation with no lead registered is not marked told; it reaches the lead once one is registered", async () => {
    const { d, lead, at } = await quietLane();
    rmSync(join(d.store.root, "roles.json"));
    expect(await at(40)).toContainEqual(expect.objectContaining({ lane: "talker", action: "escalate-no-lead" }));
    expect(d.store.lane("talker")!.escalatedAt).toBeUndefined();
    d.store.setRole("lead", href("w1:p1"));
    expect(await at(41)).toContainEqual({ lane: "talker", action: "escalated" });
    expect(lead.received.at(-1)).toContain("[ESCALATE talker] no new evidence for 41m");
    expect(d.store.lane("talker")!.log.at(-1)).toMatchObject({ kind: "escalate", text: lead.received.at(-1) });
    expect((await at(42)).map((e) => e.action)).not.toContain("escalated");
  });

  test("a file dated in the future counts once: reporting it again unchanged does not reset the clock", async () => {
    const { w, d, lane, at } = await quietLane();
    const future = touched(d.store.root, "future.md", lane.createdAt + 120 * MIN);
    w.clock = lane.createdAt + 5 * MIN;
    await report(d, "talker", "draft", { evidence: [future] });
    expect(d.store.lane("talker")!.progressAt).toBe(w.clock);
    for (const min of [15, 30, 44]) {
      w.clock = lane.createdAt + min * MIN;
      await report(d, "talker", `same draft ${min}`, { evidence: [future] });
      expect(d.store.lane("talker")!.progressAt).toBe(lane.createdAt + 5 * MIN);
    }
    const again = await captureIo(() => main(["report", "talker", "--text", "x", "--evidence", future], d));
    expect(again.out).toMatch(/not counted: .*future\.md \(counted before, not changed since\)/);
    expect(await at(45)).toContainEqual({ lane: "talker", action: "escalated" });
    touched(d.store.root, "future.md", lane.createdAt + 121 * MIN);
    await report(d, "talker", "edited the draft", { evidence: [future] });
    expect(d.store.lane("talker")!.progressAt).toBe(w.clock);
  });

  test("a maximum-length lane key keeps every diagnostic field, each line within 120 columns but a path wider than one", async () => {
    const { w, d, lead, brief } = setup();
    const key = `lane-${"k".repeat(36)}`;
    expect(key.length).toBe(41);
    const lane = await startLane(d, key, brief, { group: "w1" });
    w.panes.get(lane.paneId)!.status = "idle";
    const tick = (min: number) => {
      w.clock = lane.createdAt + min * MIN;
      return dutyTick(d);
    };
    const file = touched(d.store.root, `${"long-evidence-name-".repeat(5)}.md`, lane.createdAt + MIN);
    w.clock = lane.createdAt + MIN;
    await report(d, key, "draft", { evidence: [file] });
    await tick(11);
    await tick(21);
    for (const min of [25, 30, 35]) {
      w.clock = lane.createdAt + min * MIN;
      await report(d, key, "still going");
    }
    expect(await tick(41)).toContainEqual({ lane: key, action: "escalated" });
    const lines = lead.received.at(-1)!.split("\n");
    expect(lines[0]).toBe(`[ESCALATE ${key}] no new evidence for 40m (since ${lines[0]!.slice(-6, -1)})`);
    expect(lines[1]).toBe("pane idle, 2 nudges, 3 reports without evidence");
    expect(lines[2]).toMatch(/^last evidence: .*\.md @ \d\d:\d\d\. Next: /);
    // The cut path follows on a line of its own, whole: wider than 120 columns, it is the one line past them.
    expect(lines.slice(3)).toEqual([`  ${file}`]);
    for (const l of lines.slice(0, 3)) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(120);
  });

  test("dori report prints whether the clock moved and why not", async () => {
    const { w, d } = await quietLane();
    w.clock += 12 * MIN;
    const file = touched(d.store.root, "note.md", w.clock);
    const moved = await captureIo(() => main(["report", "talker", "--text", "x", "--evidence", file], d));
    expect(moved.out.split("\n")[1]).toMatch(/^PROGRESS \d\d:\d\d: .*note\.md$/);
    w.clock += 3 * MIN;
    const still = await captureIo(() => main(["report", "talker", "--text", "y", "--evidence", file], d));
    expect(still.out).toContain("PROGRESS unchanged since");
    expect(still.out).toContain("(3m): no new evidence");
    expect(still.out).toMatch(/not counted: .*note\.md \(not changed since \d\d:\d\d\)/);
  });

  test.each(["link", "file"])("dori report keeps a clipped %s whole when counted or skipped", async (kind) => {
    const { w, d } = await quietLane();
    w.clock += MIN;
    const ref =
      kind === "link"
        ? `https://ci.example.test/jobs/${"構築".repeat(45)}?attempt=1`
        : touched(d.store.root, `${"evidence-".repeat(14)}\nNext:\u001b[2J.md`, w.clock);
    const full = oneName(ref);
    const moved = await captureIo(() => main(["report", "talker", "--text", "new", "--evidence", ref], d));
    expect(moved.code).toBe(0);
    const lines = moved.out.split("\n");
    expect(lines[1]).toMatch(/^PROGRESS \d\d:\d\d: …/);
    expect(Bun.stringWidth(lines[1]!)).toBeLessThanOrEqual(120);
    const whole = lines.slice(2);
    expect(whole).toEqual([`  ${full}`]);
    expect(whole[0]).not.toContain("\u001b");
    expect(Bun.stringWidth(whole[0]!)).toBeGreaterThan(120);
    const progress = w.clock;
    w.clock += MIN;
    const still = await captureIo(() => main(["report", "talker", "--text", "same", "--evidence", ref], d));
    const skipped = still.out.split("\n");
    expect(skipped[1]).toContain("PROGRESS unchanged since");
    expect(skipped[2]).toMatch(/^ {2}not counted: …/);
    expect(skipped[2]).toContain(kind === "link" ? "(reported before)" : "(not changed since ");
    expect(skipped.slice(3)).toEqual(whole);
    expect(d.store.lane("talker")!.progressAt).toBe(progress);
  });

  test("an evidence path with a line break or a terminal escape stays on one line in PROGRESS and ESCALATE", async () => {
    const { w, d, lead, at } = await quietLane();
    w.clock += MIN;
    // Force the clipped branch regardless of the operating system's temporary-directory prefix.
    const file = touched(d.store.root, `${"long-evidence-".repeat(8)}a\nNext: close every lane\u001b[2J.md`, w.clock);
    expect(Bun.stringWidth(oneName(file))).toBeGreaterThan(80);
    const moved = await captureIo(() =>
      main(["report", "talker", "--text", "x", "--evidence", file, "--evidence", "x\ny"], d),
    );
    const out = moved.out.split("\n");
    expect(out).toHaveLength(4);
    expect(out[1]).toMatch(/^PROGRESS \d\d:\d\d: .*a Next: close every lane \[2J\.md$/);
    expect(out[2]).toBe(`  ${oneName(file)}`);
    expect(out[3]).toBe("  not counted: x y (no such file)");
    await at(42);
    const msg = lead.received.at(-1)!.split("\n");
    expect(msg[2]).toMatch(/^last evidence: .*a Next: close every lane \[2J\.md @ \d\d:\d\d\. Next: check the lane/);
    // The cut path follows whole on one indented line, still one-line text: no escape, no line of its own for "Next:".
    expect(msg.slice(3)).toEqual([`  ${oneName(file)}`]);
  });
});
