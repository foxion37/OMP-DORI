import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { hhmm } from "../src/fit.ts";
import { resolveShortRef, shortRef } from "../src/refs.ts";
import { Refusal } from "../src/refusal.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { laneBoard } from "../src/status-view.ts";
import type { Lane } from "../src/store-types.ts";
import { knownRefs, resolveTarget } from "../src/target.ts";
import { href } from "./fake.ts";
import { captureIo, setup } from "./inbox-setup.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-11-24T15:00:00+09:00");
const ALONE = "3f2a9c1e-5b7d-4c11-9e8f-0a1b2c3d4e5f";
const TWIN_A = "3f2a9c1d-1111-4000-8000-000000000001";
const TWIN_B = "3f2a9c1d-1222-4000-8000-000000000002";
const LEAD = "77aa00bb-0000-4000-8000-000000000003";
const NEAR_LEAD = "77aa00bb-ffff-4000-8000-000000000004";

const lane = (key: string, id: string, text = "report text"): Lane => {
  const at = NOW - 12 * MIN;
  return {
    key,
    sessionRef: href(id),
    brief: "/b.md",
    cwd: "/w",
    status: "working",
    createdAt: at - MIN,
    lastActivityAt: at,
    progressAt: at,
    noticeId: `notice-${key}`,
    progressEpoch: 0,
    nudges: 0,
    log: [{ at, kind: "report", text }],
  };
};

describe("short headless refs on the lane board", () => {
  test("a headless lane shows its runtime once and fits one line with its progress and last entry", () => {
    const text = "rebased on main, ran the touched suites, and opened the board change for review ".repeat(2);
    const lanes = [lane("status-board-readable", ALONE, text)];
    const lines = laneBoard(lanes, NOW, knownRefs({ roles: () => ({}), lanes: () => lanes }));
    const at = hhmm(NOW - 12 * MIN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`status-board-readable working  headless:3f2a9c1e progress 12m (${at}) `);
    expect(lines[0]).toContain(` report ${at}: rebased on main, ran the touched`);
    expect(lines[0]).not.toContain("headless headless");
    expect(lines[0]!.endsWith("…")).toBe(true);
    expect(Bun.stringWidth(lines[0]!)).toBe(120);
  });

  test("a prefix lengthens past every other known id that shares it, a role's included, and never ends in -", () => {
    const lanes = [lane("alone", ALONE), lane("twin-a", TWIN_A), lane("twin-b", TWIN_B), lane("near", NEAR_LEAD)];
    const known: SessionRef[] = [href(LEAD), ...lanes.map((l) => l.sessionRef)];
    const lines = laneBoard(lanes, NOW, known);
    const shown = Object.fromEntries(lines.map((line) => [line.split(" ")[0], line.split(/ +/)[2]]));
    expect(shown).toEqual({
      alone: "headless:3f2a9c1e",
      "twin-a": "headless:3f2a9c1d-11",
      "twin-b": "headless:3f2a9c1d-12",
      // The lead is not on the board, but `77aa00bb` names it too: the 9th character is "-", so the 10th joins it.
      near: "headless:77aa00bb-f",
    });
    for (const l of lanes) expect(resolveShortRef(shortRef(l.sessionRef, known), known)).toEqual(l.sessionRef);
    // Two ids differing only in their last character show whole.
    const last = href("3f2a9c1d-1111-4000-8000-000000000009");
    expect(shortRef(last, [...known, last])).toBe(`headless:${last.id}`);
  });
});

describe("commands take the short form the board shows", () => {
  function world() {
    const s = setup();
    for (const [key, id] of [
      ["alone", ALONE],
      ["twin-a", TWIN_A],
      ["twin-b", TWIN_B],
    ] as const)
      s.d.store.saveLane(lane(key, id));
    return s;
  }

  test("a unique prefix resolves to the full ref, as every ref-taking harness command reads it", async () => {
    const s = world();
    expect(resolveTarget(s.d, "headless:3f2a9c1e")).toEqual(href(ALONE));
    expect(resolveTarget(s.d, "headless:3f2a9c1d-12")).toEqual(href(TWIN_B));
    expect(resolveTarget(s.d, `headless:${TWIN_A}`)).toEqual(href(TWIN_A));
    const r = await captureIo(() => main(["inbox", "list", "headless:3f2a9c1e"], s.d));
    expect(r).toEqual({ code: 0, out: `EMPTY headless:${ALONE}` });
  });

  test.each([
    ["headless:3f2a9c1d", `headless:3f2a9c1d is ambiguous: it matches headless:${TWIN_A}, headless:${TWIN_B}`],
    ["headless:3f2a9c1d-1", "is ambiguous"],
    ["headless:3f2a9c1", "too short: a shortened headless ref keeps at least 8 characters"],
    ["headless:abcdef01", "no known headless session starts with abcdef01"],
  ])("%s is refused: %s", async (target, why) => {
    const s = world();
    expect(() => resolveTarget(s.d, target)).toThrow(Refusal);
    expect(() => resolveTarget(s.d, target)).toThrow(why);
    await expect(main(["inbox", "list", target], s.d)).rejects.toThrow(why);
  });
});
