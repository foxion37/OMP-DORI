import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { send } from "../src/inbox.ts";
import type { Deps } from "../src/harness.ts";
import { World, href, sid, tref } from "./fake.ts";

// #89: a delivery that failed after the text may already have reached the session is never re-sent blindly.

const LEAD = "1";
const P2 = sid(2);
const P2_TARGET = `headless:${P2}`;

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addTerminal(LEAD, "idle");
  d.store.setRole("lead", tref(LEAD));
  const deliveries = (id: string) => w.calls.filter((c) => c.cmd === "deliver" && c.argv[0] === id).length;
  return { w, d, lead, deliveries };
}

/** Runs the CLI and captures everything it writes: console.log, console.error and raw stderr writes. */
async function captureIo(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  const write = process.stderr.write;
  console.log = (...a: unknown[]) => {
    out.push(a.join(" "));
  };
  console.error = (...a: unknown[]) => {
    err.push(a.join(" "));
  };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), out: out.join("\n"), err: err.join("") };
  } finally {
    console.log = log;
    console.error = error;
    process.stderr.write = write;
  }
}

const HELD_LINE = (target: string) => `HELD ${target}: delivery may or may not have reached the pane; do not resend`;

function addLane(d: Deps, key: string, id: string): void {
  d.store.saveLane({
    key,
    sessionRef: href(id),
    brief: "/dev/null",
    cwd: "/",
    status: "working",
    createdAt: 0,
    lastActivityAt: 0,
    progressAt: 0,
    noticeId: `notice-${key}`,
    progressEpoch: 0,
    nudges: 0,
    log: [],
  });
}

describe("ambiguous native delivery (#89 B)", () => {
  test("the lead is told exactly once across several dutyTicks and the message is not re-sent", async () => {
    const { w, d, lead, deliveries } = setup();
    const lane = w.addPane(P2, "idle");
    w.deliverFails.set(P2, "timeout");
    await d.store.enqueue(href(P2), { at: w.clock, from: "cli", text: "SECRET instruction" }, false);

    const ticks = [await dutyTick(d), await dutyTick(d), await dutyTick(d)];
    for (const events of ticks) {
      expect(events).toContainEqual(expect.objectContaining({ pane: P2_TARGET, action: "delivery-ambiguous" }));
      expect(events.some((e) => e.action === "flush-failed")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("SECRET");
    }
    expect(deliveries(P2)).toBe(1);
    expect(lane.received).toEqual([]);
    const notices = lead.received.filter((m) => m.includes(P2));
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain("SECRET");
    expect(d.store.queued(href(P2))).toHaveLength(1);
  });

  test("an ambiguous failure on the lead's own session is held and not re-sent, with no notice loop", async () => {
    const { w, d, lead, deliveries } = setup();
    w.deliverFails.set(LEAD, "timeout");
    expect(await send(d, "lead", "hello", "cli")).toBe("HELD");
    for (let i = 0; i < 3; i++) await dutyTick(d);
    w.deliverFails.delete(LEAD);
    expect(await dutyTick(d)).toContainEqual(
      expect.objectContaining({ pane: `tern:${LEAD}`, action: "delivery-ambiguous" }),
    );
    // one delivery for the message, one for the notice about it; neither is retried
    expect(deliveries(LEAD)).toBe(2);
    expect(lead.received).toEqual([]);
  });
});

describe("a legacy typed entry with newer messages queued", () => {
  const typedFirst = (at: number) => [
    {
      at: at - 1,
      from: "cli",
      text: "FIRST",
      attempt: { at: at - 1, state: "typed" as const, detail: "key press failed" },
    },
  ];

  test("headless: the typed entry is held, never typed or submitted; the newer message is delivered on the next pass", async () => {
    const { w, d, lead, deliveries } = setup();
    const p2 = w.addPane(P2, "idle");
    d.store.saveInbox(href(P2), typedFirst(w.clock));
    expect(await send(d, P2_TARGET, "SECOND", "cli")).toBe("QUEUED");
    expect(deliveries(P2)).toBe(0);
    expect(d.store.queued(href(P2)).find((m) => m.text === "FIRST")?.attempt?.state).toBe("ambiguous");

    // The next pass delivers SECOND; FIRST itself is never sent, and the lead hears of it once.
    await dutyTick(d);
    expect(p2.received).toEqual(["SECOND"]);
    expect(lead.received.join("\n")).toContain(`[DELIVERY-AMBIGUOUS ${P2_TARGET}]`);
    expect(lead.received.join("\n")).not.toContain("FIRST");
    expect(d.store.queued(href(P2)).map((m) => m.text)).toEqual(["FIRST"]);
  });

  test("tern: send() of the newer message presses only the pending Enter, returns QUEUED, and keeps it queued", async () => {
    const { w, d, lead, deliveries } = setup();
    d.store.saveInbox(tref(LEAD), typedFirst(w.clock));
    expect(await send(d, "lead", "SECOND", "cli")).toBe("QUEUED");
    expect(w.calls.filter((c) => c.cmd === "submit")).toHaveLength(1);
    expect(deliveries(LEAD)).toBe(0);
    expect(d.store.queued(tref(LEAD)).map((m) => m.text)).toEqual(["SECOND"]);

    expect(await dutyTick(d)).toEqual([{ pane: `tern:${LEAD}`, action: "flushed" }]);
    expect(lead.received).toEqual(["SECOND"]);
    expect(d.store.queued(tref(LEAD))).toEqual([]);
  });
});

describe("the CLI on an uncertain first delivery (#89 review)", () => {
  test("cataly send, ambiguous delivery: prints HELD, exits 3, never shows the text, and holds exactly one entry", async () => {
    const { w, d, deliveries } = setup();
    w.addPane(P2, "idle");
    w.deliverFails.set(P2, "timeout");
    const r = await captureIo(() => main(["send", P2_TARGET, "--text", "SECRET instruction"], d));
    expect(r.code).toBe(3);
    expect(r.out).toBe(HELD_LINE(P2_TARGET));
    expect(r.out + r.err).not.toContain("SECRET");
    const held = d.store.queued(href(P2));
    expect(held).toHaveLength(1);
    expect(held[0]!.attempt?.state).toBe("ambiguous");
    expect(deliveries(P2)).toBe(1);
  });

  test("cataly report, ambiguous delivery to the lead: no crash, prints HELD for the lead, exits 3, report held once", async () => {
    const { w, d } = setup();
    addLane(d, "fix-x", P2);
    w.addPane(P2, "working");
    w.deliverFails.set(LEAD, "timeout");
    const r = await captureIo(() => main(["report", "fix-x", "--text", "SECRET progress"], d));
    expect(r.code).toBe(3);
    expect(r.out.split("\n")).toEqual([
      "REPORTED fix-x",
      expect.stringMatching(/^PROGRESS unchanged since /),
      HELD_LINE("lead"),
    ]);
    expect(r.out + r.err).not.toContain("SECRET");
    const fromLane = d.store.queued(tref(LEAD)).filter((m) => m.from === "fix-x");
    expect(fromLane).toHaveLength(1);
    expect(fromLane[0]!.attempt?.state).toBe("ambiguous");
    expect(d.store.lane("fix-x")!.log.at(-1)).toMatchObject({ kind: "report", text: "SECRET progress" });
  });

  test("cataly ready, ambiguous delivery to the lead: no crash, prints HELD for the lead, exits 3, READY recorded", async () => {
    const { w, d } = setup();
    addLane(d, "fix-x", P2);
    w.addPane(P2, "idle");
    w.deliverFails.set(LEAD, "timeout");
    const r = await captureIo(() =>
      main(["ready", "fix-x", "--text", "SECRET answer", "--evidence", "https://example.com/pr/1"], d),
    );
    expect(r.code).toBe(3);
    expect(r.out).toBe(`READY fix-x\n${HELD_LINE("lead")}`);
    expect(r.out + r.err).not.toContain("SECRET");
    expect(d.store.queued(tref(LEAD)).filter((m) => m.from === "fix-x")).toHaveLength(1);
    expect(d.store.lane("fix-x")!.status).toBe("ready");
  });
});

describe("control", () => {
  test("normal delivery is unchanged: delivered once, inbox empty", async () => {
    const { d, lead, deliveries } = setup();
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
    expect(deliveries(LEAD)).toBe(1);
    expect(d.store.queued(tref(LEAD))).toEqual([]);
    expect(await dutyTick(d)).toEqual([]);
    expect(deliveries(LEAD)).toBe(1);
  });
});
