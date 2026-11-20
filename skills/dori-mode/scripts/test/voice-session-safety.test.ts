import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLiveEvent } from "../src/voice/provider.ts";
import { Replies } from "../src/voice/replies.ts";
import { call, count, flush } from "./voice-fixture.ts";
import { fixture, voiced } from "./voice-session-fixture.ts";

test.each([false, true])("delegated quota failure holds re-entry, even while closing (%s)", async (closing) => {
  const f = fixture();
  try {
    const current = await f.start();
    current.handlers.event({ type: "session.delegation.created", delegation: { id: "d1", response_id: "r1" } });
    const failure = parseLiveEvent({
      type: "response.event",
      delegation_id: "d1",
      event: {
        type: "response.failed",
        response: { id: "r1", error: { code: "insufficient_quota" }, usage: { input_tokens: 50, output_tokens: 2 } },
      },
    });
    expect(failure.event?.response?.error?.code).toBe("insufficient_quota");
    if (closing) f.engine.ownerPresence(false);
    current.handlers.event(failure);
    current.handlers.event({
      type: "response.event",
      delegation_id: "d1",
      event: call("late", "forward_to_lead", { message: "work", risky: false }),
    });
    await flush();
    expect(count(current.wires, "session.close")).toBe(1);
    expect(count(current.wires, "response.create")).toBe(0);
    expect(f.counts().tools).toBe(0);
    current.handlers.closed();
    await flush();
    expect(f.failedSummaries).toEqual([true]);
    expect(f.logs).toContain(
      closing
        ? "VOICE_SESSION_CLOSING owner left"
        : "VOICE_SESSION_CLOSING provider backend failure insufficient_quota",
    );
    f.engine.ownerPresence(false);
    f.engine.ownerPresence(true);
    for (let i = 0; i < 20; i++) f.engine.pcm(voiced());
    expect(f.sessions).toHaveLength(1);
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});

test("barge-in discards acknowledged reply audio without advancing its durable offset", async () => {
  const f = fixture();
  try {
    const text = "This checked answer must be replayed after an interruption.";
    writeFileSync(join(f.directory, "lead-replies.jsonl"), `${JSON.stringify({ re: "request", text })}\n`);
    const current = await f.start();
    f.time(5000);
    f.engine.tick();
    const offered = current.wires.find((wire) => String(wire["event_id"]).startsWith("reply_"))!;
    current.handlers.event({ type: "session.commentary.appended", client_event_id: String(offered["event_id"]) });
    current.handlers.event({ type: "session.output_transcript.delta", delta: text });
    const speech = Buffer.alloc(48_000);
    for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(3000, i);
    current.handlers.event({ type: "session.output_audio.delta", delta: speech.toString("base64") });
    await flush();
    expect(f.playback.queuedMs()).toBe(1000);
    for (let i = 0; i < 20; i++) f.engine.pcm(voiced());
    expect(f.playback.queuedMs()).toBe(0);
    f.time(8000);
    f.engine.tick();
    expect(f.logs).toContain("VOICE_REPLY_INTERRUPTED");
    expect(current.wires.filter((wire) => String(wire["event_id"]).startsWith("reply_"))).toHaveLength(2);
    expect(existsSync(join(f.directory, "lead-replies.state.json"))).toBe(false);
    f.engine.ownerPresence(false);
    current.handlers.closed();
    await flush();
    const restored = new Replies(f.directory, () => {});
    restored.scan();
    expect(restored.first()?.text).toBe(text);
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});

test("a partially played reply stays pending until its final padded frame is pulled", async () => {
  const f = fixture();
  try {
    const text = "The last part of this reply has to reach the local player.";
    const cursor = join(f.directory, "lead-replies.state.json");
    writeFileSync(join(f.directory, "lead-replies.jsonl"), `${JSON.stringify({ re: "request", text })}\n`);
    const current = await f.start();
    f.time(5000);
    f.engine.tick();
    const offered = current.wires.find((wire) => String(wire["event_id"]).startsWith("reply_"))!;
    current.handlers.event({ type: "session.commentary.appended", client_event_id: String(offered["event_id"]) });
    current.handlers.event({ type: "session.output_transcript.delta", delta: text });
    current.handlers.event({ type: "session.output_audio.delta", delta: Buffer.alloc(1008, 12).toString("base64") });
    expect(f.playback.read()).not.toBeNull();
    expect(f.playback.queuedMs()).toBe(1);
    expect(f.playback.read()).toBeNull();
    f.time(7000);
    f.engine.tick();
    expect(existsSync(cursor)).toBe(false);
    const tail = f.playback.read()!;
    expect(tail.readInt16LE(0)).toBe(3084);
    expect(tail.readInt16LE(192)).toBe(0);
    f.time(8000);
    f.engine.tick();
    expect(existsSync(cursor)).toBe(true);
    const restored = new Replies(f.directory, () => {});
    restored.scan();
    expect(restored.first()).toBeUndefined();
    current.handlers.closed();
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});

test("a failed reply write cannot keep a local close live", async () => {
  const f = fixture();
  try {
    const text = "The completed reply must stay pending if its offset cannot be written.";
    writeFileSync(join(f.directory, "lead-replies.jsonl"), `${JSON.stringify({ re: "request", text })}\n`);
    const current = await f.start();
    f.time(5000);
    f.engine.tick();
    const offered = current.wires.find((wire) => String(wire["event_id"]).startsWith("reply_"))!;
    f.time(5001);
    current.handlers.event({ type: "session.commentary.appended", client_event_id: String(offered["event_id"]) });
    f.time(5002);
    current.handlers.event({ type: "session.output_transcript.delta", delta: text });
    current.handlers.event({ type: "session.output_audio.delta", delta: Buffer.alloc(960, 12).toString("base64") });
    expect(f.playback.read()).not.toBeNull();
    mkdirSync(join(f.directory, "lead-replies.state.json.tmp"));
    f.time(7000);
    f.engine.ownerPresence(false);
    expect(count(current.wires, "session.close")).toBe(1);
    current.handlers.closed();
    await f.engine.stop();
    expect(f.failedSummaries).toEqual([true]);
    expect(f.logs).toContain("VOICE_CLOSE_PERSIST_FAILED");
    expect(existsSync(join(f.directory, "lead-replies.state.json"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test.each(["input", "output"])("a sustained %s burst holds voice without using truncated audio", async (side) => {
  const f = fixture();
  try {
    const current = await f.start();
    if (side === "input") {
      for (let i = 0; i < 151; i++) f.engine.pcm(voiced());
    } else {
      const delta = Buffer.alloc(48_000, 12).toString("base64");
      for (let i = 0; i < 6; i++) current.handlers.event({ type: "session.output_audio.delta", delta });
    }
    expect(count(current.wires, "session.close")).toBe(1);
    f.engine.tick();
    expect(count(current.wires, "session.input_audio.append")).toBe(0);
    expect(f.playback.queuedMs()).toBe(0);
    current.handlers.closed();
    await f.engine.stop();
    expect(f.failedSummaries).toEqual([true]);
  } finally {
    f.cleanup();
  }
});
