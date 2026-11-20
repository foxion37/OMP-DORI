import { afterEach, beforeEach, expect, test } from "bun:test";
import { footer } from "../src/launch-footer.ts";
import type { Lane } from "../src/registry.ts";
import { reportLine, Reports } from "../src/reports.ts";
import { type TestState, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = {
  key: "final-report",
  title: "Final report contract",
  thread: "none",
  brief: "/briefs/final-report.md",
  done: "closed acme/app#1",
  openedAt: new Date(T0).toISOString(),
};
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("the generated footer supplies five factual report lines in order", () => {
  const text = footer(lane, "");
  const labels = [...text.matchAll(/^(Outcome|Changes\/findings|Verified|Unverified|Handoff):/gm)].map(
    (match) => match[1],
  );
  expect(labels).toEqual(["Outcome", "Changes/findings", "Verified", "Unverified", "Handoff"]);
  expect(text).toContain("observed commands/results and receipts tied to each acceptance condition");
  expect(text).toContain("checks not run, reasons and remaining uncertainty");
  expect(text).toContain("No blank placeholders or invented tests, results or handoff tasks");
  expect(text).toContain("For investigation-only work, report findings and source evidence instead of invented edits");
});

test("the footer's claim example uses a report ID and live Done receipts", () => {
  const text = footer(lane, "");
  expect(text).toContain("partial uses milestone; blocked uses blocker; cancelled uses halted");
  expect(text).toContain("Only completed work with every Done signal read back live uses kind done or claim-done");
  expect(text).toContain("A report, output file or successful send alone is not acceptance evidence");
  expect(text).toContain('claim-done final-report --evidence "report:<id>; <shareable live Done receipts>"');
  expect(text).toContain('report final-report --kind "$kind" --text "$text"');
});

test.each([
  ["partial", "milestone", "running"],
  ["blocked", "blocker", "blocked"],
  ["cancelled", "halted", "halted"],
] as const)("%s retains unrun checks without becoming done", (outcome, kind, expected) => {
  const text = [
    `Outcome: ${outcome}; report fixture`,
    "Changes/findings: fixture boundary note",
    "Verified: a scoped fixture check completed",
    "Unverified: integration checks not run; fixture dependency unavailable",
    "Handoff: resolve the fixture dependency before integration checks",
  ].join("\n");
  const reports = new Reports(state.dir);
  const saved = reports.report(lane.key, kind, text, T0);
  const reloaded = new Reports(state.dir).read(lane.key);
  expect(reloaded?.state).toBe(expected);
  expect(reloaded?.state).not.toBe("done");
  expect(reloaded?.lastReport?.text).toBe(text);
  expect(reloaded?.lastReport?.text).toContain("Unverified: integration checks not run");
  expect(reportLine(saved)).toContain("Unverified: integration checks not run");
});
