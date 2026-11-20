import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Decisions } from "../src/decisions.ts";
import { type DecisionAsk, settled } from "../src/decisions-record.ts";
import { type TestState, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-04T00:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

let state: TestState;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

// Another writer's record, appended as that writer would: op first, with its own nonce.
const append = (ledger: Decisions, event: Record<string, unknown>) =>
  appendFileSync(ledger.path, `${JSON.stringify(event)}\n`);

/** A ledger whose next write meets a competing record: after its checks, or after its append. */
const racing = (where: "beforeAppend" | "beforeReadback", event: () => Record<string, unknown>) => {
  let fired = false;
  const ledger: Decisions = new Decisions(state.dir, {
    [where]: () => {
      if (fired) return;
      fired = true;
      append(ledger, event());
    },
  });
  return ledger;
};

const routine = (question: string): DecisionAsk => ({
  question,
  source: "d:t/1",
  thread: "d:t",
  kind: "routine",
  options: ["JSON lines", "plain text"],
});
const choice = { reason: "matches the existing parser", source: "d:t/5", thread: "d:t" };

test("an owner decision, asked so or recorded before kinds, is never settled by the lead's choice", () => {
  // Given cost, permission and scope questions marked owner or with no kind, and a hand-written pre-kind record.
  const ledger = new Decisions(state.dir);
  const owner = [
    ledger.ask({ ...routine("Spend $40 a month on a bigger runner?"), kind: "owner", options: ["yes", "no"] }, T0),
    ledger.ask({ ...routine("Give the lane push access to main?"), kind: "owner", options: ["yes", "no"] }, T0),
    ledger.ask(
      { question: "Widen the goal to the mobile app?", source: "d:t/1", thread: "d:t", options: ["yes", "no"] },
      T0,
    ),
  ];
  append(ledger, {
    op: "ask",
    id: "0000beef",
    at: at(1),
    n: "0000000a",
    question: "Publish the beta?",
    source: "d:t/2",
    thread: "d:t",
    options: ["now", "later"],
  });
  const before = readFileSync(ledger.path, "utf8");
  // When the lead tries to choose each; then each is refused and nothing is written.
  const ids = [...owner.map((d) => d.id), "0000beef"];
  for (const id of ids)
    expect(() => ledger.choose(id, "1", choice, T0 + 2)).toThrow(
      `decision ${id} is the owner's to answer; the lead chooses only a routine one`,
    );
  expect(readFileSync(ledger.path, "utf8")).toBe(before);
  // And every one reads as the owner's and stays open.
  const read = ledger.read();
  expect(read.items.map((d) => [d.id, d.kind, settled(d)])).toEqual(ids.map((id) => [id, "owner", undefined]));
  expect(read.problems).toEqual([]);
  // And the owner's own answer still settles a pre-kind record.
  expect(ledger.answer("0000beef", "2", "d:t/9", T0 + 3)).toMatchObject({
    kind: "owner",
    answer: "2",
    option: 2,
    answerSource: "d:t/9",
    authority: "owner",
  });
});

test("a routine decision cannot use the absent-thread sentinel in its API or journal", () => {
  const ledger = new Decisions(state.dir);
  expect(() => ledger.ask({ ...routine("Log format?"), thread: "none" }, T0)).toThrow(
    "a routine decision needs the thread of the work it belongs to",
  );
  expect(existsSync(ledger.path)).toBe(false);
  append(ledger, {
    op: "ask",
    id: "0000beef",
    at: at(0),
    n: "0000000a",
    ...routine("Log format?"),
    thread: "none",
  });
  expect(ledger.read()).toEqual({
    items: [],
    problems: [`${ledger.path}:1: a routine decision needs the thread of the work it belongs to`],
    warnings: [],
  });
});

test("the lead's choice must be one listed option number, in the decision's own thread", () => {
  // Given an open routine decision in thread d:t.
  const ledger = new Decisions(state.dir);
  const d = ledger.ask(routine("Log format?"), T0);
  const before = readFileSync(ledger.path, "utf8");
  // When choosing outside the options, with free text, or for another thread; then each is refused.
  const refused: [string, string, string][] = [
    ["3", "d:t", `decision ${d.id} takes the lead's choice of option 1 to 2; 3 is not one`],
    ["0", "d:t", `decision ${d.id} takes the lead's choice of option 1 to 2; 0 is not one`],
    ["plain text", "d:t", `decision ${d.id} takes the lead's choice of option 1 to 2; plain text is not one`],
    ["2 because it is smaller", "d:t", "2 because it is smaller is not one"],
    ["1", "d:other", `decision ${d.id} belongs to thread d:t, not d:other`],
    ["1", "d:t/1", `decision ${d.id} belongs to thread d:t, not d:t/1`],
  ];
  for (const [option, thread, message] of refused)
    expect(() => ledger.choose(d.id, option, { ...choice, thread }, T0 + 1)).toThrow(message);
  // And nothing was written, so the decision is still open.
  expect(readFileSync(ledger.path, "utf8")).toBe(before);
  expect(settled(ledger.read().items[0]!)).toBeUndefined();
  // And an unknown decision is refused as before.
  expect(() => ledger.choose("0000beef", "1", choice, T0 + 1)).toThrow("decision not found: 0000beef");
});

test("a hand-written choice that breaks the authority rules is damage and settles nothing, even after an answer", () => {
  // Given an owner decision and a routine one.
  const ledger = new Decisions(state.dir);
  const owner = ledger.ask({ question: "Pay for it?", source: "d:t/1", thread: "d:t", options: ["yes", "no"] }, T0);
  const d = ledger.ask(routine("Log format?"), T0);
  const lead = { reason: "r", source: "d:t/5", thread: "d:t" };
  // When records appended past the command break each rule.
  for (const event of [
    { op: "choose", id: owner.id, at: at(1), n: "0000000a", option: 1, ...lead },
    { op: "choose", id: d.id, at: at(2), n: "0000000b", option: 1, ...lead, source: "d:x/5", thread: "d:x" },
    { op: "choose", id: d.id, at: at(3), n: "0000000c", option: 3, ...lead },
    { op: "choose", id: d.id, at: at(4), n: "0000000d", ...lead },
    { op: "choose", id: d.id, at: at(5), n: "0000000e", option: 1, ...lead, answer: "JSON lines" },
    {
      op: "ask",
      id: "0000beef",
      at: at(6),
      n: "0000000f",
      question: "Q?",
      source: "s:1",
      kind: "routine",
      options: ["a", "b"],
    },
    { op: "ask", id: "0000cafe", at: at(7), n: "00000010", question: "Q?", source: "s:1", thread: "d:t", kind: "lead" },
  ])
    append(ledger, event);
  // Then each is named as damage, and both decisions stay open.
  const read = ledger.read();
  expect(read.problems).toEqual([
    `${ledger.path}:3: decision ${owner.id} is the owner's to answer; the lead chooses only a routine one`,
    `${ledger.path}:4: decision ${d.id} belongs to thread d:t; a choice recorded for d:x is not its`,
    `${ledger.path}:5: decision ${d.id} has no option 3`,
    `${ledger.path}:6: the lead's choice must name an option number`,
    `${ledger.path}:7: unknown decision field "answer"`,
    `${ledger.path}:8: a routine decision needs the thread of the work it belongs to`,
    `${ledger.path}:9: decision field "kind" must be owner or routine`,
  ]);
  expect(read.warnings).toEqual([]);
  expect(read.items.map((item) => [item.id, settled(item)])).toEqual([
    [owner.id, undefined],
    [d.id, undefined],
  ]);
  // And once the owner has answered, a forged choice is still damage, never a lost race, and the answer stands.
  ledger.answer(owner.id, "no", "d:t/9", T0 + 10);
  append(ledger, { op: "choose", id: owner.id, at: at(11), n: "00000011", option: 1, ...lead });
  const after = ledger.read();
  expect(after.problems.at(-1)).toBe(
    `${ledger.path}:11: decision ${owner.id} is the owner's to answer; the lead chooses only a routine one`,
  );
  expect(after.warnings).toEqual([]);
  expect(after.items[0]).toMatchObject({ answer: "no", authority: "owner", answerSource: "d:t/9" });
});

test("racing the owner: the first of an owner answer and a lead choice wins, and the loser is told", () => {
  // Given a routine decision, and an owner answer recorded between the lead's checks and its append.
  const plain = new Decisions(state.dir);
  const d = plain.ask(routine("Log format?"), T0);
  const ownerFirst = racing("beforeAppend", () => ({
    op: "answer",
    id: d.id,
    at: at(1),
    n: "0000000a",
    answer: "2",
    option: 2,
    source: "d:t/9",
  }));
  // When the lead chooses; then its choice is ignored and it is told, and the owner's answer stands.
  expect(() => ownerFirst.choose(d.id, "1", choice, T0 + 2)).toThrow(
    `decision ${d.id} was already answered; choose ignored`,
  );
  expect(plain.read().items[0]).toMatchObject({ answer: "2", option: 2, authority: "owner", answerSource: "d:t/9" });
  // And when the lead's choice lands first, the owner answer recorded after it is the one told it lost.
  const e = plain.ask(routine("Log rotation?"), T0 + 3);
  const leadFirst = racing("beforeAppend", () => ({
    op: "choose",
    id: e.id,
    at: at(4),
    n: "0000000b",
    option: 1,
    ...choice,
  }));
  expect(() => leadFirst.answer(e.id, "2", "d:t/10", T0 + 5)).toThrow(
    `decision ${e.id} was already answered; answer ignored`,
  );
  expect(plain.read().items[1]).toMatchObject({
    answer: "JSON lines",
    option: 1,
    authority: "lead",
    reason: choice.reason,
  });
  // And a withdrawal appended after the lead's choice but before its readback is ignored, the choice standing.
  const f = plain.ask(routine("Log level?"), T0 + 6);
  const late = racing("beforeReadback", () => ({ op: "withdraw", id: f.id, at: at(8), n: "0000000c", reason: "moot" }));
  expect(late.choose(f.id, "2", choice, T0 + 7)).toMatchObject({ answer: "plain text", authority: "lead" });
  expect(plain.read().warnings.at(-1)).toEndWith(`decision ${f.id} was already answered; withdraw ignored`);
});
