import { expect, test } from "bun:test";

import { socketPathLength, socketRootBase } from "./socket-budget.ts";

const session = "e2e-123456";
const sized = (n: number) => `/${"t".repeat(n - 1)}`;

test("the budget counts a terminal holder's socket, the longest name hc creates", () => {
  // 6 (tmpdir) + 24 ("/dhc-XXXXXX/r/herdr-core/") + 10 (session) + 22 (".holder.00000000.sock")
  expect(socketPathLength("/tmp/x", session)).toBe(62);
});

test("the budget keeps a tmpdir with room for the holder socket and falls back to /tmp one byte later", () => {
  const fits = sized(44);
  expect(socketPathLength(fits, session)).toBe(100);
  expect(socketRootBase(fits, session)).toBe(fits);
  const over = sized(45);
  expect(socketPathLength(over, session)).toBe(101);
  expect(socketRootBase(over, session)).toBe("/tmp");
});
