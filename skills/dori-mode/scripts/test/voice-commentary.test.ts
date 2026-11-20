import { expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Commentary } from "../src/voice/commentary.ts";
import { quickFacts } from "../src/voice/facts.ts";
import { Replies } from "../src/voice/replies.ts";
import type { Wire } from "../src/voice/types.ts";
import { backendFixture, call, completed, created, temporaryVoice } from "./voice-fixture.ts";

const timing = (now: number, patch = {}) => ({
  now,
  lastOwnerAt: 1000,
  lastOutputAt: 0,
  queuedMs: 0,
  playbackGeneration: 0,
  playedFrames: 0,
  audible: true,
  ...patch,
});
const ack = (c: Commentary, event: Wire, now: number) =>
  c.event({ type: "session.commentary.appended", client_event_id: String(event["event_id"]) }, now);

test("quick facts are bounded, preserve every source, and wait for all speech guards", () => {
  const tmp = temporaryVoice();
  try {
    const f = backendFixture();
    const parts = {
      lanes: { ok: true, result: "Running lane. ".repeat(200) },
      reports: { ok: true, result: "Recent result. ".repeat(200) },
    };
    const content = quickFacts(parts);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(500);
    expect(content).toContain("[lanes]");
    expect(content).toContain("[reports]");
    const d = f.backend.delegations.get("d1")!;
    d.partials.push({ id: "quick1", readyAt: 2000, content });
    f.backend.pending.set("work", { delegationId: "d1", name: "forward_to_lead" });
    const c = new Commentary(
      new Replies(tmp.directory, () => {}),
      f.backend,
      (e) => f.wires.push(e),
      () => {},
    );
    c.tick(timing(2000));
    c.tick(timing(4000, { lastOutputAt: 3800 }));
    c.tick(timing(4000, { queuedMs: 100 }));
    expect(f.wires).toHaveLength(0);
    c.tick(timing(4000));
    c.tick(timing(5000));
    expect(f.wires).toHaveLength(1);
    expect(d.doneAt).toBeUndefined();
    c.event({ type: "error", error: { code: "context_injection_incomplete", client_event_id: "quick1" } }, 5000);
    c.tick(timing(6000));
    expect(f.wires).toHaveLength(1);
    expect(d.partials[0]?.rejected).toBe(true);
  } finally {
    tmp.cleanup();
  }
});

test("quick status precedes a slow write but never races the final response", async () => {
  const tmp = temporaryVoice();
  const slow = Promise.withResolvers<{ ok: boolean; result: string }>();
  try {
    const f = backendFixture(async (name) =>
      name === "get_status"
        ? { ok: true, result: "all known facts", parts: { lanes: { ok: true, result: "one lane running" } } }
        : slow.promise,
    );
    const c = new Commentary(
      new Replies(tmp.directory, () => {}),
      f.backend,
      (e) => f.wires.push(e),
      () => {},
    );
    await f.backend.event(created("r1"), "d1");
    const work = f.backend.event(call("work", "forward_to_lead", { message: "work", risky: false }), "d1");
    await f.backend.event(call("status", "get_status", { what: ["lanes"], speak_now: true }), "d1");
    c.tick(timing(4000));
    expect(f.wires.some((e) => e["type"] === "session.commentary.append")).toBe(true);
    expect(f.backend.delegations.get("d1")?.doneAt).toBeUndefined();
    await f.backend.event(completed("r1"), "d1");
    slow.resolve({ ok: true, result: "delivered" });
    await work;
    const d = f.backend.delegations.get("d1")!;
    d.partials.push({ id: "late", readyAt: 6000, content: "late facts" });
    c.tick(timing(8000));
    expect(f.wires.filter((e) => e["type"] === "session.commentary.append")).toHaveLength(1);
    const output = f.wires.find((e) => e["type"] === "response.item.create");
    expect(JSON.stringify(output)).toContain("all known facts");
  } finally {
    tmp.cleanup();
  }
});

test("injection interrupted on exit survives restart, acknowledgement alone never consumes", () => {
  const tmp = temporaryVoice();
  try {
    const f = backendFixture();
    f.backend.delegations.clear();
    const replies = new Replies(tmp.directory, () => {});
    const state = join(tmp.directory, "lead-replies.state.json");
    const line = `${JSON.stringify({ re: "the request", text: "This verified reply must survive an interrupted injection." })}\n`;
    writeFileSync(replies.file, line);
    const c = new Commentary(
      replies,
      f.backend,
      (e) => f.wires.push(e),
      () => {},
    );
    c.tick(timing(10_000));
    ack(c, f.wires[0]!, 10_001);
    c.tick(timing(12_000));
    expect(existsSync(state)).toBe(false);
    c.close(timing(13_000));
    const next = new Commentary(
      new Replies(tmp.directory, () => {}),
      f.backend,
      (e) => f.wires.push(e),
      () => {},
    );
    next.tick(timing(20_000));
    expect(f.wires).toHaveLength(2);
    ack(next, f.wires[1]!, 20_001);
    next.event(
      { type: "session.output_transcript.delta", delta: "This verified reply must survive an interrupted injection." },
      20_002,
    );
    next.noteAudio({ generation: 0, queuedMs: () => 0, playedFrames: 0 });
    next.tick(timing(20_003, { lastOutputAt: 22_000, queuedMs: 200 }));
    expect(existsSync(state)).toBe(false);
    next.tick(timing(24_000, { lastOutputAt: 22_000, playedFrames: 10 }));
    expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({ offset: Buffer.byteLength(line) });
    const again = new Replies(tmp.directory, () => {});
    again.scan();
    expect(again.first()).toBeUndefined();
  } finally {
    tmp.cleanup();
  }
});

test("an acknowledgement without a matching flight is ignored", () => {
  const tmp = temporaryVoice();
  try {
    const f = backendFixture();
    const c = new Commentary(
      new Replies(tmp.directory, () => {}),
      f.backend,
      () => {},
      () => {},
    );
    expect(() => c.event({ type: "session.commentary.appended" }, f.now())).not.toThrow();
    expect(() => c.event({ type: "session.commentary.appended", client_event_id: "unrelated" }, f.now())).not.toThrow();
  } finally {
    tmp.cleanup();
  }
});

test("a long reply consumes the JSONL line only after every bounded piece, including a short tail", () => {
  const tmp = temporaryVoice();
  try {
    const f = backendFixture();
    f.backend.delegations.clear();
    const replies = new Replies(tmp.directory, () => {});
    const text = `${"A checked fact. ".repeat(150)}OK`;
    writeFileSync(replies.file, `${JSON.stringify({ re: "request", text })}\n`);
    const c = new Commentary(
      replies,
      f.backend,
      (e) => f.wires.push(e),
      () => {},
    );
    let now = 5000;
    c.tick(timing(now));
    let spoken = "";
    for (let index = 0; index < 100 && replies.first(); index++) {
      const wire = f.wires.at(-1)!;
      const content = String(wire["content"]);
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(500);
      const part: { text: string } = JSON.parse(content.slice(content.indexOf("{")));
      spoken += part.text;
      ack(c, wire, now + 1);
      c.event({ type: "session.output_transcript.delta", delta: part.text }, now + 2);
      c.noteAudio({ generation: 0, queuedMs: () => 0, playedFrames: index });
      now += 2000;
      c.tick(timing(now, { lastOutputAt: now - 1500, playedFrames: index + 1 }));
    }
    expect(spoken).toBe(text);
    expect(replies.first()).toBeUndefined();
    expect(f.wires.length).toBeGreaterThan(2);
  } finally {
    tmp.cleanup();
  }
});

test.each(["tick", "close"] as const)("transcript with no played audio leaves the reply pending on %s", (finish) => {
  const tmp = temporaryVoice();
  try {
    const f = backendFixture();
    f.backend.delegations.clear();
    const replies = new Replies(tmp.directory, () => {});
    const text = "The transcript is not evidence that this reply was played.";
    writeFileSync(replies.file, `${JSON.stringify({ re: "request", text })}\n`);
    const c = new Commentary(
      replies,
      f.backend,
      (e) => f.wires.push(e),
      () => {},
    );
    c.tick(timing(5000));
    ack(c, f.wires[0]!, 5001);
    c.event({ type: "session.output_transcript.delta", delta: text }, 5002);
    // Old audio can finish draining after the acknowledgement; it cannot prove this flight played.
    c[finish](timing(8000, { lastOutputAt: 6000, playedFrames: 8 }));
    expect(replies.first()?.text).toBe(text);
    expect(existsSync(join(tmp.directory, "lead-replies.state.json"))).toBe(false);
  } finally {
    tmp.cleanup();
  }
});

test("partial lines wait, replaced logs cannot be acknowledged by an old reply", () => {
  const tmp = temporaryVoice();
  try {
    const replies = new Replies(tmp.directory, () => {});
    writeFileSync(replies.file, '{"text":"kept"}');
    replies.scan();
    expect(replies.first()).toBeUndefined();
    appendFileSync(replies.file, "\n");
    replies.scan();
    const old = replies.first()!;
    const replacement = join(tmp.directory, "replacement.jsonl");
    writeFileSync(replacement, '{"text":"new reply"}\n');
    renameSync(replacement, replies.file);
    replies.scan();
    replies.spoken(old);
    expect(replies.first()?.text).toBe("new reply");
    replies.spoken(replies.first()!);
    const next = new Replies(tmp.directory, () => {});
    next.scan();
    expect(next.first()).toBeUndefined();
  } finally {
    tmp.cleanup();
  }
});
