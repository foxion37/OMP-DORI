import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  bumpAttempts,
  MAX_CONTINUATIONS,
  openOwes,
  OWE_TTL_MS,
  owesInText,
  recordMark,
  recordOwes,
  recordSent,
  reminder,
} from "../src/owes.ts";
import { withState } from "./fakes.ts";

const at = Date.UTC(2026, 10, 17, 5, 0, 0);
const CHANNEL = "1570973386363117651";
const inbound = (channel: string, message: string, text: string, params = `ref=-`) =>
  `INBOUND discord ${channel} ${message} from=owner ${params} ${JSON.stringify(text)}`;

describe("owesInText", () => {
  test("an owner line is an owe; other lines in the same delivery are not", () => {
    const text = [
      inbound(CHANNEL, "100", "배포 왜 안 됨"),
      'INBOUND_REPLY discord 100 {"message":"90"}',
      `INBOUND discord ${CHANNEL} 101 from=bot ref=- "self"`,
      "PRESENCE discord resumed",
    ].join("\n");
    expect(owesInText(text, at)).toEqual([
      { id: `${CHANNEL}:100`, channel: CHANNEL, message: "100", at, text: "배포 왜 안 됨" },
    ]);
  });

  test("a quoted body that is not JSON keeps its raw text instead of losing the owe", () => {
    expect(owesInText(`INBOUND discord ${CHANNEL} 100 from=owner ref=- "unbalanced`, at)[0]?.text).toBe('"unbalanced');
  });

  test("the [name] prefix a monitor adds still parses, and the burst's other lines are ignored", () => {
    const burst = [`[inbound] ${inbound(CHANNEL, "100", "둘 다 해")}`, "[inbound] PRESENCE discord resumed"].join("\n");
    expect(owesInText(burst, at)).toEqual([
      { id: `${CHANNEL}:100`, channel: CHANNEL, message: "100", at, text: "둘 다 해" },
    ]);
  });
});

describe("ledger", () => {
  test("a reply alone does not settle an owe: the owner's message also needs its read receipt", async () => {
    const state = withState();
    try {
      await recordOwes(state.dir, inbound(CHANNEL, "100", "first"), at);
      await recordSent(state.dir, CHANNEL, "100", ["701"], at + 2);
      expect(openOwes(state.dir, at + 3).map((owe) => owe.id)).toEqual([`${CHANNEL}:100`]);

      await recordMark(state.dir, CHANNEL, "100", at + 4);
      expect(openOwes(state.dir, at + 5)).toEqual([]);
    } finally {
      state.done();
    }
  });

  test("a read receipt alone does not settle it either: the owner still has to be answered", async () => {
    const state = withState();
    try {
      await recordOwes(state.dir, inbound(CHANNEL, "100", "first"), at);
      await recordMark(state.dir, CHANNEL, "100", at + 1);
      expect(openOwes(state.dir, at + 2).map((owe) => owe.id)).toEqual([`${CHANNEL}:100`]);
      await recordSent(state.dir, CHANNEL, "100", ["701"], at + 3);
      expect(openOwes(state.dir, at + 4)).toEqual([]);
    } finally {
      state.done();
    }
  });

  test("a receipt on a different message does not count: the mark names one message", async () => {
    const state = withState();
    try {
      await recordOwes(state.dir, inbound(CHANNEL, "100", "first"), at);
      await recordSent(state.dir, CHANNEL, "100", ["701"], at + 1);
      await recordMark(state.dir, CHANNEL, "999", at + 2);
      expect(openOwes(state.dir, at + 3).map((owe) => owe.id)).toEqual([`${CHANNEL}:100`]);
    } finally {
      state.done();
    }
  });

  test("a receipt from before the message cannot settle it, on either half", async () => {
    const state = withState();
    try {
      await recordSent(state.dir, CHANNEL, "100", ["701"], at - 10);
      await recordMark(state.dir, CHANNEL, "100", at - 10);
      await recordOwes(state.dir, inbound(CHANNEL, "100", "later"), at);
      expect(openOwes(state.dir, at + 1).map((owe) => owe.id)).toEqual([`${CHANNEL}:100`]);
    } finally {
      state.done();
    }
  });

  test("a send receipt closes only its own channel, and only for answered messages", async () => {
    const state = withState();
    try {
      await recordOwes(state.dir, inbound(CHANNEL, "100", "first"), at);
      await recordOwes(state.dir, inbound("999", "200", "other channel"), at);
      expect(openOwes(state.dir, at + 1).map((owe) => owe.id)).toEqual([`${CHANNEL}:100`, "999:200"]);

      await recordSent(state.dir, CHANNEL, "100", ["701"], at + 2);
      await recordMark(state.dir, CHANNEL, "100", at + 2);
      expect(openOwes(state.dir, at + 3).map((owe) => owe.id)).toEqual(["999:200"]);

      await recordOwes(state.dir, inbound(CHANNEL, "300", "later"), at + 4);
      expect(openOwes(state.dir, at + 5).map((owe) => owe.id)).toEqual(["999:200", `${CHANNEL}:300`]);
    } finally {
      state.done();
    }
  });

  test("the same delivery twice is one owe, so a replay cannot double-count", async () => {
    const state = withState();
    try {
      const line = inbound(CHANNEL, "100", "once");
      expect(await recordOwes(state.dir, line, at)).toBe(1);
      expect(await recordOwes(state.dir, line, at + 1)).toBe(0);
      expect(openOwes(state.dir, at + 2)).toHaveLength(1);
    } finally {
      state.done();
    }
  });

  test("a crash's leftovers expire instead of resurrecting yesterday's message", async () => {
    const state = withState();
    try {
      await recordOwes(state.dir, inbound(CHANNEL, "100", "stale"), at);
      expect(openOwes(state.dir, at + OWE_TTL_MS - 1)).toHaveLength(1);
      expect(openOwes(state.dir, at + OWE_TTL_MS + 1)).toHaveLength(0);
    } finally {
      state.done();
    }
  });

  test("a torn final line is skipped, and a missing ledger is empty rather than an error", async () => {
    const state = withState();
    try {
      expect(openOwes(state.dir, at)).toEqual([]);
      await recordOwes(state.dir, inbound(CHANNEL, "100", "kept"), at);
      const path = join(state.dir, "owes", "inbound.jsonl");
      writeFileSync(path, `${readFileSync(path, "utf8")}{"id":"trunc"`);
      expect(openOwes(state.dir, at + 1).map((owe) => owe.id)).toEqual([`${CHANNEL}:100`]);
    } finally {
      state.done();
    }
  });

  test("the ledger files are owner-only and never empty", async () => {
    const state = withState();
    try {
      await recordOwes(state.dir, inbound(CHANNEL, "100", "secret"), at);
      await recordSent(state.dir, CHANNEL, "100", ["701"], at + 1);
      bumpAttempts(state.dir, [`${CHANNEL}:100`]);
      const dir = join(state.dir, "owes");
      for (const name of ["inbound.jsonl", "sent.jsonl", "attempts.json"]) {
        const path = join(dir, name);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8").trim()).not.toBe("");
        if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      state.done();
    }
  });

  test("the ledgers stay capped instead of growing with every send", async () => {
    const state = withState();
    try {
      for (let i = 0; i < 250; i++) await recordSent(state.dir, CHANNEL, "100", ["701"], at + i);
      const lines = readFileSync(join(state.dir, "owes", "sent.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(lines.length).toBeLessThanOrEqual(200);
      // The newest receipt survives the trim, so an answer sent just now still settles its owe.
      await recordOwes(state.dir, inbound(CHANNEL, "900", "now"), at + 300);
      expect(openOwes(state.dir, at + 400).map((owe) => owe.id)).toEqual([`${CHANNEL}:900`]);
    } finally {
      state.done();
    }
  });

  test("attempts accumulate per owe so the gate can stop looping", () => {
    const state = withState();
    try {
      const id = `${CHANNEL}:100`;
      expect(bumpAttempts(state.dir, [id])[id]).toBe(1);
      expect(bumpAttempts(state.dir, [id])[id]).toBe(2);
      expect(bumpAttempts(state.dir, [id])[id]).toBe(3);
      expect(MAX_CONTINUATIONS).toBeGreaterThan(0);
    } finally {
      state.done();
    }
  });

  test("an unreadable attempts file is replaced rather than crashing the settle", () => {
    const state = withState();
    try {
      mkdirSync(join(state.dir, "owes"), { recursive: true });
      writeFileSync(join(state.dir, "owes", "attempts.json"), "{not json");
      expect(bumpAttempts(state.dir, ["a:1"])).toEqual({ "a:1": 1 });
      expect(bumpAttempts(state.dir, ["a:1"])).toEqual({ "a:1": 2 });
    } finally {
      state.done();
    }
  });
});

describe("reminder", () => {
  test("it names the channel, the message and the exact command to run", () => {
    const text = reminder([{ id: `${CHANNEL}:100`, channel: CHANNEL, message: "100", at, text: "배포" }]);
    expect(text).toContain("dori send discord --to <channel>");
    expect(text).toContain(`channel ${CHANNEL}, owner message 100`);
    expect(text).toContain("배포");
  });

  test("a burst is truncated so the continuation stays readable", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `${CHANNEL}:${100 + i}`,
      channel: CHANNEL,
      message: String(100 + i),
      at,
      text: "x",
    }));
    const text = reminder(many);
    expect(text).toContain("owner message 104");
    expect(text).not.toContain("owner message 105");
    expect(text).toContain("and 4 more");
  });
});
