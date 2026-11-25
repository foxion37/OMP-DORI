import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { flushInbox } from "../src/inbox.ts";
import { formatRef } from "../src/runtime/types.ts";
import { captureIo, PANE, setup } from "./inbox-setup.ts";
import { href } from "./fake.ts";

// #108: follow-ups to #89 (PR 102).

const REF = href(PANE);
const SHOWN = formatRef(REF);

describe("a typed entry in a native inbox (#108 1)", () => {
  test("an idle native lane has no terminal input to submit, so it is held instead of submitted", async () => {
    const s = setup();
    s.d.store.saveInbox(REF, [
      { at: s.w.clock, from: "cli", text: "half typed", attempt: { at: s.w.clock + 1, state: "typed" } },
    ]);

    expect(await flushInbox(s.d, REF)).toBe("held");
    expect(s.d.store.queued(REF).map((msg) => msg.attempt?.state)).toEqual(["ambiguous"]);
    expect(s.pane.received).toEqual([]);
  });
});

describe("releasing held entries: cataly inbox list | ack | resend (#108 2)", () => {
  function heldInbox(s: ReturnType<typeof setup>) {
    const long = `SECRET "quoted"\n${"x".repeat(100)}`;
    s.d.store.saveInbox(REF, [
      { at: 0, from: "lane-a", text: long, attempt: { at: 1, state: "ambiguous", detail: "timeout" } },
      { at: 60_000, from: "cli", text: "typed one", attempt: { at: 60_001, state: "typed" } },
      { at: 120_000, from: "duty", text: "plain" },
    ]);
    return long;
  }

  test("list prints index, state, sender and queued time, and at most the first 60 characters JSON-escaped", async () => {
    const s = setup();
    const long = heldInbox(s);
    const r = await captureIo(() => main(["inbox", "list", SHOWN], s.d));
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      `1 held from lane-a queued 1970-01-01T00:00:00.000Z ${JSON.stringify(long.slice(0, 60))}...`,
      `2 typed from cli queued 1970-01-01T00:01:00.000Z "typed one"`,
      `3 queued from duty queued 1970-01-01T00:02:00.000Z "plain"`,
    ]);
    expect(r.out).not.toContain("x".repeat(61));
  });

  test("ack drops the held entry and nothing else; a role name resolves to its pane", async () => {
    const s = setup();
    heldInbox(s);
    s.d.store.setRole("duty", REF);
    const r = await captureIo(() => main(["inbox", "ack", "duty", "1"], s.d));
    expect(r).toEqual({ code: 0, out: `ACKED ${SHOWN} 1` });
    expect(s.d.store.queued(REF).map((m) => m.text)).toEqual(["typed one", "plain"]);
  });

  test("ack and resend refuse an entry that is not held, and an index out of range", async () => {
    const s = setup();
    heldInbox(s);
    await expect(main(["inbox", "ack", SHOWN, "2"], s.d)).rejects.toThrow(/not held/);
    await expect(main(["inbox", "resend", SHOWN, "3"], s.d)).rejects.toThrow(/not held/);
    await expect(main(["inbox", "ack", SHOWN, "4"], s.d)).rejects.toThrow(/no entry 4/);
    await expect(main(["inbox", "ack", SHOWN, "x"], s.d)).rejects.toThrow(/no entry/);
    expect(s.d.store.queued(REF)).toHaveLength(3);
  });

  test("resend clears the attempt, and the next flush delivers it exactly once", async () => {
    const s = setup();
    s.d.store.saveInbox(REF, [
      { at: 0, from: "cli", text: "again", attempt: { at: 1, state: "ambiguous", detail: "timeout" } },
    ]);
    expect(await dutyTick(s.d)).toContainEqual(expect.objectContaining({ pane: SHOWN, action: "delivery-ambiguous" }));
    expect(s.pane.received).toEqual([]);
    const r = await captureIo(() => main(["inbox", "resend", SHOWN, "1"], s.d));
    expect(r.out).toBe(`RELEASED ${SHOWN} 1: the next flush delivers it`);
    expect(s.d.store.queued(REF)).toEqual([{ at: 0, from: "cli", text: "again" }]);
    expect(await dutyTick(s.d)).toEqual([{ pane: SHOWN, action: "flushed" }]);
    expect(await dutyTick(s.d)).toEqual([]);
    expect(s.pane.received).toEqual(["again"]);
  });

  test("a gone pane with only held entries reports inbox-target-gone, not delivery-ambiguous", async () => {
    const s = setup();
    s.d.store.saveInbox(REF, [{ at: 0, from: "cli", text: "held", attempt: { at: 1, state: "ambiguous" } }]);
    s.w.panes.delete(PANE);
    expect(await dutyTick(s.d)).toEqual([{ pane: SHOWN, action: "inbox-target-gone" }]);
  });
});
