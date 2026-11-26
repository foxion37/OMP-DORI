import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryLeadInbox, leadCarryPath, readLeadCarry, unheldCarry } from "../src/inbox-carry.ts";

const root = () => mkdtempSync(join(tmpdir(), "cataly-carry-"));

test("a stop carries only messages the lead never tried to read", () => {
  const home = root();
  const carried = carryLeadInbox(home, [
    { at: 2, from: "cli", text: "둘째" },
    { at: 1, from: "cli", text: "첫째" },
    // Delivery was ambiguous: the old session may hold it, so the next lead must not answer it twice.
    { at: 3, from: "cli", text: "모호한 전달", attempt: { state: "ambiguous", at: 3 } },
    // Typed into the session's input: repeating it would duplicate the message.
    { at: 4, from: "cli", text: "입력됨", attempt: { state: "typed", at: 4 } },
  ]);
  expect(carried).toBe(2);
  expect(readLeadCarry(home)).toEqual([
    { at: 1, from: "cli", text: "첫째" },
    { at: 2, from: "cli", text: "둘째" },
  ]);
});

test("a stop with nothing unread keeps the carry an earlier stop wrote", () => {
  const home = root();
  expect(carryLeadInbox(home, [{ at: 1, from: "cli", text: "갔음", attempt: { state: "typed", at: 1 } }])).toBe(0);
  expect(readLeadCarry(home)).toEqual([]);
  carryLeadInbox(home, [{ at: 1, from: "cli", text: "읽지 않음" }]);
  // The next up has not consumed it yet: an empty stop must not erase it.
  expect(carryLeadInbox(home, [])).toBe(1);
  expect(readLeadCarry(home)).toEqual([{ at: 1, from: "cli", text: "읽지 않음" }]);
});

test("a second stop adds to the carry an unrestored first stop wrote", () => {
  const home = root();
  carryLeadInbox(home, [{ at: 1, from: "cli", text: "첫 stop" }]);
  // A failed up leaves the carry: the next stop carries its own message without losing the first.
  expect(carryLeadInbox(home, [{ at: 2, from: "cli", text: "둘째 stop" }])).toBe(2);
  expect(readLeadCarry(home)).toEqual([
    { at: 1, from: "cli", text: "첫 stop" },
    { at: 2, from: "cli", text: "둘째 stop" },
  ]);
});

test("a resumed lead's own queue is not restored a second time", () => {
  const carried = [
    { at: 1, from: "cli", text: "이미 큐에 있음" },
    { at: 2, from: "cli", text: "새 메시지" },
  ];
  expect(unheldCarry(carried, [{ at: 1, from: "cli", text: "이미 큐에 있음" }])).toEqual([
    { at: 2, from: "cli", text: "새 메시지" },
  ]);
});

test("a damaged carry line loses one message, not the restart", () => {
  const home = root();
  carryLeadInbox(home, [{ at: 1, from: "cli", text: "살아남음" }]);
  const path = leadCarryPath(home);
  Bun.write(path, `${readFileSync(path, "utf8")}{not json\n`);
  expect(readLeadCarry(home)).toEqual([{ at: 1, from: "cli", text: "살아남음" }]);
  expect(readdirSync(join(home, "inbox")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});
