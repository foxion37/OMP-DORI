import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import { Decisions } from "../src/decisions.ts";
import { shellQuote } from "../src/launch-footer.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const HOUR = 3_600_000;

let state: TestState;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

const bootDeps = () => {
  const sessionsDir = join(state.dir, "sessions");
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { sessionsDir, leadPane: "tern:5001" });
  return {
    ...deps,
    reports: new Reports(state.dir),
    worklog: new Worklog(state.dir),
    decisions: new Decisions(state.dir),
    slack: async () => null,
    sessionsDir,
  };
};

test("without decisions.jsonl boot prints exactly what it printed before decisions existed", async () => {
  // Given an open worklog item and no decision ever asked.
  const deps = bootDeps();
  deps.worklog.add("A request", "slack:D1/1.1", T0);
  // When boot runs with and without the decisions reader.
  const { decisions: _, ...without } = deps;
  const withLedger = await bootCheck(deps);
  // Then the output is the same, line for line, and no DECISIONS line appears.
  expect(withLedger).toEqual(await bootCheck(without));
  expect(withLedger.lines.some((line) => line.startsWith("DECI"))).toBe(false);
  expect(withLedger.exitCode).toBe(0);
});

test("open decisions print after the worklog with age, lane and thread; resolved ones do not", async () => {
  // Given two open decisions, one with a lane and thread, and an answered and a withdrawn one.
  const deps = bootDeps();
  const ledger = deps.decisions;
  const store = ledger.ask(
    { question: 'Which "store"?', source: "s:1", lane: "store-lane", thread: "discord:c9/1", options: ["a", "b"] },
    T0 - 5 * HOUR - 1,
  );
  const plain = ledger.ask({ question: "Rename?", source: "s:2" }, T0 - HOUR + 1);
  const answered = ledger.ask({ question: "Answered?", source: "s:3" }, T0 - 2 * HOUR);
  ledger.answer(answered.id, "yes", "s:4", T0 - HOUR);
  const withdrawn = ledger.ask({ question: "Moot?", source: "s:5" }, T0 - 2 * HOUR);
  ledger.withdraw(withdrawn.id, "moot", T0 - HOUR);
  // When boot runs.
  const result = await bootCheck(deps);
  // Then the open ones follow the WORKLOG lines, oldest first, and the exit is 0.
  const worklogAt = result.lines.indexOf("WORKLOG open=0");
  expect(result.lines.slice(worklogAt + 1, worklogAt + 4)).toEqual([
    "DECISIONS open=2",
    `DECIDE ${store.id} age=5h lane=store-lane thread=discord:c9/1 "Which \\"store\\"?"`,
    `DECIDE ${plain.id} age=0h lane=- thread=- "Rename?"`,
  ]);
  expect(result.lines.some((line) => line.includes(answered.id) || line.includes(withdrawn.id))).toBe(false);
  expect(result.exitCode).toBe(0);
});

test("a damaged decision line fails the boot, a late answer is only a warning, and an unreadable ledger fails it", async () => {
  // Given an answered decision with a second answer after it, and a garbage line.
  const deps = bootDeps();
  const ledger = deps.decisions;
  const d = ledger.ask({ question: "Raced?", source: "s:1" }, T0);
  ledger.answer(d.id, "first", "s:2", T0 + 1);
  const late = {
    op: "answer",
    id: d.id,
    at: new Date(T0 + 2).toISOString(),
    n: "0000000a",
    answer: "second",
    source: "s:3",
  };
  appendFileSync(ledger.path, `${JSON.stringify(late)}\nnot a record\n`);
  // When boot runs; then the warning and the damage are both named, and the damage alone fails the boot.
  const result = await bootCheck(deps);
  const [open, damaged, ...rest] = result.lines.filter((line) => line.startsWith("DECISIONS "));
  expect(open).toBe("DECISIONS open=0");
  expect(damaged).toStartWith(`DECISIONS damaged ${ledger.path}:4: JSON Parse error`);
  expect(rest).toEqual([`DECISIONS warning ${ledger.path}:3: decision ${d.id} was already answered; answer ignored`]);
  expect(result.exitCode).toBe(1);
  // And a ledger path that cannot be read as a file is named and fails the boot.
  const other = withState();
  try {
    mkdirSync(join(other.dir, "decisions.jsonl"));
    const unreadable = await bootCheck({ ...deps, decisions: new Decisions(other.dir) });
    expect(unreadable.lines).toContain(`DECISIONS unreadable ${shellQuote(join(other.dir, "decisions.jsonl"))}`);
    expect(unreadable.exitCode).toBe(1);
  } finally {
    other.done();
  }
});
