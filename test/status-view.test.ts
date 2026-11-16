import { describe, expect, test } from "bun:test";
import { ageText, fitEnd, fitStart, hhmm, oneLine, wrap } from "../src/fit.ts";
import { laneBoard } from "../src/status-view.ts";
import type { Lane } from "../src/store-types.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-11-14T20:45:00+09:00");

const lane = (key: string, status: Lane["status"], progressMinAgo: number, text = "report text"): Lane => {
  const at = NOW - progressMinAgo * MIN;
  return {
    key,
    sessionRef: { runtime: "herdr", id: "w1:p3", container: "w1:t1" },
    paneId: "w1:p3",
    tabId: "w1:t1",
    brief: "/b.md",
    cwd: "/w",
    status,
    createdAt: at - MIN,
    lastActivityAt: at,
    progressAt: at,
    nudges: 0,
    log: [{ at, kind: "report", text }],
  };
};

describe("the lane board", () => {
  test("open lanes first, longest without progress on top; closed lanes fold into one line each", () => {
    const lines = laneBoard(
      [
        lane("fresh", "working", 5),
        lane("old-done", "done", 900),
        lane("stuck", "waiting", 130),
        lane("new-done", "done", 35),
        lane("ready-one", "ready", 20),
        lane("gone", "lost", 60),
      ],
      NOW,
    );
    expect(lines.map((l) => l.split(" ")[0])).toEqual(["stuck", "ready-one", "fresh", "lost", "done"]);
    const at = hhmm(NOW - 130 * MIN);
    // A record from before `--for` names its last report as the target and waits since its last progress; the last
    // entry follows, cut to the 120 columns.
    expect(lines[0]).toMatch(
      new RegExp(
        `^stuck\\s+waiting\\s+herdr\\s+w1:p3\\s+progress 2h10m \\(${at}\\)\\s+waiting: report text since ${at} \\| rep`,
      ),
    );
    expect(Bun.stringWidth(lines[0]!)).toBeLessThanOrEqual(120);
    expect(lines.at(-1)).toBe("done 2 (latest new-done, 35m ago)");
  });

  test("every line fits 120 columns, wide text included, and is cut on a whole character", () => {
    // Fullwidth letters take two terminal columns each, like CJK text; the sample is neutral filler.
    const long =
      "operator note: ＷＩＤＥ ＴＥＸＴ ＣＵＴ ＨＥＲＥ ＯＮ Ａ ＷＨＯＬＥ ＣＨＡＲＡＣＴＥＲ\nsecond line ".repeat(6);
    for (const line of laneBoard([lane("long-lane-key-width-24ch", "working", 61 * 60, long)], NOW)) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
      expect(line).toContain("progress 2d13h");
      expect(line).not.toContain("\n");
      expect(line.endsWith("…")).toBe(true);
    }
  });

  test("width helpers count wide characters twice and keep a path's file name", () => {
    expect(fitEnd("ＷＩＤＥ", 5)).toBe("ＷＩ…");
    expect(Bun.stringWidth(fitEnd("ＷＩＤＥ", 5))).toBe(5);
    expect(fitStart("/very/long/path/to/the/report.md", 15)).toBe("…/the/report.md");
    expect([ageText(45 * MIN), ageText(130 * MIN), ageText(27 * 60 * MIN)]).toEqual(["45m", "2h10m", "1d3h"]);
  });

  test("two maximum-length keys sharing a prefix both show whole, with the rest of the line within 120 columns", () => {
    const a = `lane-${"k".repeat(35)}a`;
    const b = `lane-${"k".repeat(35)}b`;
    const hc = { ...lane(b, "working", 70), sessionRef: { runtime: "hc" as const, id: "t1b2c3d4e5f6g7h8" } };
    const lines = laneBoard([lane(a, "waiting", 90), hc], NOW);
    // The waiting lane's target and time do not fit beside these columns: they go on the indented line, whole.
    expect(lines).toHaveLength(3);
    expect(lines[0]!.split(" ")[0]).toBe(a);
    const t = hhmm(NOW - 90 * MIN);
    expect(lines[1]).toMatch(
      new RegExp(`^ {2}progress 1h30m \\(${t}\\) +waiting: report text since ${t} \\| report ${t}`),
    );
    expect(lines[2]!.split(" ")[0]).toBe(b);
    expect(lines[2]).toContain(" hc:t1b2c3d4e5f6g7h8 ");
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
    // Columns too wide for the rest move it below the lane's name; the name, status and ref wrap whole, never cut.
    const wide = { ...lane(a, "working", 5), sessionRef: { runtime: "hc" as const, id: `t${"z".repeat(60)}` } };
    const two = laneBoard([wide], NOW);
    expect(two).toEqual([`${a} working  hc`, `hc:t${"z".repeat(60)}`, expect.stringMatching(/^ {2}progress 5m /)]);
    for (const line of two) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
  });

  test.each(["CI 812", "ＬＯＮＧ ＴＡＲＧＥＴ ".repeat(8)])(
    "a 41-character key and 22-column ref keep the waiting clock for target %s",
    (target) => {
      const key = `lane-${"k".repeat(36)}`;
      const id = `t${"z".repeat(18)}`;
      const waiting = {
        ...lane(key, "waiting", 45),
        sessionRef: { runtime: "hc" as const, id },
        waitingFor: target,
        waitingSince: NOW - 30 * MIN,
      };
      expect(key).toHaveLength(41);
      expect(Bun.stringWidth(`hc:${id}`)).toBe(22);
      const lines = laneBoard([waiting], NOW);
      expect(lines[0]).toBe(`${key} waiting  hc    hc:${id}`);
      expect(lines[1]).toContain("  progress 45m ");
      expect(lines[1]).toContain("waiting: ");
      expect(lines[1]).toContain(` since ${hhmm(waiting.waitingSince)}`);
      // The short target fits its line and adds none; the wide one is cut there and follows whole on one indented line.
      const below = lines.slice(2);
      expect(below).toEqual(target === "CI 812" ? [] : [`  ${target.trim()}`]);
      for (const line of lines.slice(0, 2)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
    },
  );

  test("an over-width session ref and Unicode waiting target stay whole alongside both clocks", () => {
    const key = `lane-${"k".repeat(36)}`;
    const id = `t${"z".repeat(130)}`;
    const target = "ＷＩＤＥ ＴＡＲＧＥＴ ".repeat(8).trim();
    const waiting = {
      ...lane(key, "waiting", 45),
      sessionRef: { runtime: "hc" as const, id },
      waitingFor: target,
      waitingSince: NOW - 30 * MIN,
    };
    const lines = laneBoard([waiting], NOW);
    expect(lines.slice(0, 2)).toEqual([`${key} waiting  hc`, `hc:${id}`]);
    expect(lines[2]).toContain(`progress 45m (${hhmm(NOW - 45 * MIN)})`);
    expect(lines[2]).toContain(` since ${hhmm(waiting.waitingSince)}`);
    expect(lines.slice(3)).toEqual([`  ${target}`]);
    expect(lines.filter((line) => Bun.stringWidth(line) > 120)).toEqual([`hc:${id}`, `  ${target}`]);
  });

  test("terminal escapes, carriage returns and bidi overrides in a lane's text stay on its one line as spaces", () => {
    const [line] = laneBoard([lane("esc", "working", 5, "red \u001b[31mALERT\u001b[0m\rover\u202eturn\nnext")], NOW);
    expect(line).toMatch(/report \d\d:\d\d: red \[31mALERT \[0m over turn next$/);
    expect(oneLine("a\u0007\u2028b\t\tc")).toBe("a b c");
  });

  test("wrap breaks only at spaces: a word wider than the width (a path, a link, an id) keeps a line of its own, whole", () => {
    expect(wrap("lead=w1:p1 duty=w1:p2 home=/a/b", 16)).toEqual(["lead=w1:p1", "duty=w1:p2", "home=/a/b"]);
    const path = `home=/${"d".repeat(30)}`;
    expect(wrap(path, 12)).toEqual([path]);
    expect(wrap(`lead=w1:p1 ${path} next`, 16)).toEqual(["lead=w1:p1", path, "next"]);
    expect(wrap("ＷＩＤＥ ＷＯＲＤ", 5)).toEqual(["ＷＩＤＥ", "ＷＯＲＤ"]);
  });
});
