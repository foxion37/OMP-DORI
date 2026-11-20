import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { Decisions } from "../src/decisions.ts";
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

test("two writers binding one message: the first binding holds it, and the later ask is kept without it", () => {
  // Given an open decision Y, and another writer that binds message m:1 to Y after our checks passed.
  const plain = new Decisions(state.dir);
  const y = plain.ask({ question: "Y?", source: "s:1" }, T0);
  const ledger = racing("beforeAppend", () => ({ op: "posted", id: y.id, at: at(1), n: "0000000a", message: "m:1" }));
  // When we ask with --message m:1; then it fails naming Y, yet our decision is recorded without the message.
  expect(() => ledger.ask({ question: "X?", source: "s:2", message: "m:1" }, T0 + 2)).toThrow(
    `message m:1 is already bound to open decision ${y.id}; decision `,
  );
  const read = plain.read();
  const x = read.items.find((d) => d.question === "X?");
  expect(x).toEqual({ id: x?.id ?? "", question: "X?", source: "s:2", askedAt: at(2), kind: "owner", options: [] });
  expect(read.items.find((d) => d.id === y.id)?.message).toBe("m:1");
  expect(read.problems).toEqual([]);
  expect(read.warnings).toEqual([
    `${plain.path}:3: message m:1 is already bound to open decision ${y.id}; decision ${x?.id} recorded without it`,
  ]);
  // And our error says how to bind it later.
  const again = racing("beforeAppend", () => ({ op: "posted", id: y.id, at: at(3), n: "0000000b", message: "m:2" }));
  expect(() => again.ask({ question: "Z?", source: "s:3", message: "m:2" }, T0 + 4)).toThrow(
    "was recorded without the message: bind it with decision posted once the message is free",
  );
});

test("a posted that loses a message to another open decision is ignored, and the message frees once that resolves", () => {
  // Given open decisions X and Y, and a writer that binds m:1 to Y between our check and our append.
  const plain = new Decisions(state.dir);
  const x = plain.ask({ question: "X?", source: "s:1" }, T0);
  const y = plain.ask({ question: "Y?", source: "s:2" }, T0);
  const ledger = racing("beforeAppend", () => ({
    op: "ask",
    id: "0000beef",
    at: at(1),
    n: "0000000a",
    question: "W?",
    source: "s:3",
    message: "m:1",
  }));
  // When we post X as m:1; then it fails naming the holder, X stays unbound, and m:1 binds only W.
  expect(() => ledger.posted(x.id, "m:1", T0 + 2)).toThrow(
    "message m:1 is already bound to open decision 0000beef; posted ignored",
  );
  expect(
    plain
      .read()
      .items.filter((d) => d.message === "m:1")
      .map((d) => d.id),
  ).toEqual(["0000beef"]);
  // And two raw bindings of one message by two writers resolve in record order.
  append(plain, { op: "posted", id: y.id, at: at(3), n: "0000000b", message: "m:1" });
  expect(plain.read().warnings.at(-1)).toBe(
    `${plain.path}:5: message m:1 is already bound to open decision 0000beef; posted ignored`,
  );
  // And once W is answered, m:1 is free for X.
  plain.answer("0000beef", "done", "s:4", T0 + 4);
  expect(plain.posted(x.id, "m:1", T0 + 5).message).toBe("m:1");
});

test("an answer or withdraw identical to another writer's, to the millisecond, is told apart by its nonce", () => {
  // Given an open decision, and a writer that answers it with the same text at the same millisecond just before us.
  const plain = new Decisions(state.dir);
  const d = plain.ask({ question: "Same?", source: "s:1" }, T0);
  const same = { id: d.id, at: at(5), n: "0000000a" };
  const answering = racing("beforeAppend", () => ({ op: "answer", ...same, answer: "yes", source: "s:2" }));
  // When we answer; then ours is the ignored one and we are told so, not handed the other writer's answer.
  expect(() => answering.answer(d.id, "yes", "s:2", T0 + 5)).toThrow(
    `decision ${d.id} was already answered; answer ignored`,
  );
  // And the same holds for a withdrawal.
  const e = plain.ask({ question: "Moot?", source: "s:1" }, T0);
  const withdrawing = racing("beforeAppend", () => ({
    op: "withdraw",
    id: e.id,
    at: at(6),
    n: "0000000b",
    reason: "moot",
  }));
  expect(() => withdrawing.withdraw(e.id, "moot", T0 + 6)).toThrow(
    `decision ${e.id} was already withdrawn; withdraw ignored`,
  );
  // And every record carries its own nonce and still starts like a record.
  for (const line of readFileSync(plain.path, "utf8").trim().split("\n")) {
    expect(line).toStartWith('{"op":"');
    expect(JSON.parse(line).n).toMatch(/^[0-9a-f]{8}$/);
  }
});

test("a posted after another writer resolved the decision fails even when it re-records the same message", () => {
  // Given a decision posted as m:1, and a writer that answers it between our check and our append.
  const plain = new Decisions(state.dir);
  const d = plain.ask({ question: "Q?", source: "s:1", message: "m:1" }, T0);
  const ledger = racing("beforeAppend", () => ({
    op: "answer",
    id: d.id,
    at: at(1),
    n: "0000000a",
    answer: "no",
    source: "s:2",
  }));
  // When we post the same message again; then it is refused as ignored, though the message reads the same.
  expect(() => ledger.posted(d.id, "m:1", T0 + 2)).toThrow(`decision ${d.id} was already answered; posted ignored`);
});

test("a posted replaced by a later posted before the readback is told it was replaced", () => {
  // Given an open decision, and a writer that posts it again right after our append.
  const plain = new Decisions(state.dir);
  const d = plain.ask({ question: "Q?", source: "s:1" }, T0);
  const ledger = racing("beforeReadback", () => ({ op: "posted", id: d.id, at: at(2), n: "0000000a", message: "m:2" }));
  // When we post it as m:1; then we learn ours was replaced, and m:2 is the binding.
  expect(() => ledger.posted(d.id, "m:1", T0 + 1)).toThrow(
    `decision ${d.id} posted m:1 was replaced by a later posted`,
  );
  expect(plain.read().items[0]?.message).toBe("m:2");
});

test("a record without a nonce is damage", () => {
  // Given a hand-written record that lacks n.
  const plain = new Decisions(state.dir);
  append(plain, { op: "ask", id: "0000beef", at: at(0), question: "Q?", source: "s:1" });
  // Then it is a problem, and no decision is read from it.
  expect(plain.read()).toEqual({
    items: [],
    problems: [`${plain.path}:1: decision field "n" must be 8 lowercase hex digits`],
    warnings: [],
  });
});
