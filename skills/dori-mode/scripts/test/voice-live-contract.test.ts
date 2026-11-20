import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Playback } from "../src/voice/audio.ts";
import { parseLiveEvent } from "../src/voice/provider.ts";
import { Replies } from "../src/voice/replies.ts";
import { VoiceSession } from "../src/voice/session.ts";
import type { OpenVoiceSocket, VoiceTool, Wire } from "../src/voice/types.ts";
import { VoiceUsage } from "../src/voice/usage.ts";
import { call, count, flush, settings, temporaryVoice } from "./voice-fixture.ts";
import { fixture, voiced } from "./voice-session-fixture.ts";

// Documented Live envelopes and Responses items, with the WebSocket close handshake deliberately deferred.
const liveWorld = (tool: VoiceTool = async () => ({ ok: true, result: "Checked status" })) => {
  const temp = temporaryVoice();
  const config = settings();
  let now = 1000;
  let closes = 0;
  let handlers: Parameters<OpenVoiceSocket>[1] | undefined;
  const wires: Wire[] = [];
  const usage = new VoiceUsage(temp.directory, config, () => now);
  const session = new VoiceSession(
    config,
    {
      now: () => now,
      key: "synthetic-no-paid-key",
      open: (_key, events) => {
        handlers = events;
        return {
          send: (event) => wires.push(event),
          close: () => closes++,
          terminate: () => events.closed(),
        };
      },
      playback: new Playback(),
      replies: new Replies(temp.directory, () => {}),
      usage,
      tool,
      log: () => {},
      started: () => {},
      finished: async () => {},
    },
    false,
  );
  session.open();
  return {
    config,
    directory: temp.directory,
    session,
    wires,
    open: () => handlers!.open(),
    event: (raw: unknown) => handlers!.event(parseLiveEvent(raw)),
    closes: () => closes,
    time: (value: number) => {
      now = value;
    },
    cleanup: async () => {
      if (session.state !== "closed") {
        session.close("shutdown");
        handlers!.closed();
      }
      await session.done;
      temp.cleanup();
    },
  };
};

test("documented Live startup gates 24 kHz audio and delegates configured Responses tools", async () => {
  const w = liveWorld();
  try {
    w.open();
    expect(w.wires).toHaveLength(1);
    expect(w.wires[0]).toMatchObject({
      type: "session.start",
      event_id: expect.any(String),
      session: {
        model: w.config.liveModel,
        store: false,
        audio: { format: { type: "audio/pcm", rate: 24_000 }, output: { voice: w.config.voice } },
        delegation: {
          type: "responses",
          responses: {
            model: w.config.backendModel,
            tool_choice: "auto",
            parallel_tool_calls: true,
            reasoning: { effort: w.config.backendReasoning },
            tools: [
              { type: "web_search" },
              { type: "function", name: "forward_to_lead", strict: true },
              { type: "function", name: "get_status", strict: true },
              { type: "function", name: "post_note", strict: true },
            ],
          },
        },
      },
    });
    w.session.inputAudio(Buffer.alloc(960), true);
    w.time(1040);
    w.session.tick();
    expect(count(w.wires, "session.input_audio.append")).toBe(0);
    w.event({ type: "session.started", session: { id: "live_fixture" } });
    w.session.inputAudio(Buffer.alloc(960), true);
    w.time(1080);
    w.session.tick();
    expect(count(w.wires, "session.input_audio.append")).toBe(1);
    w.event({
      type: "session.delegation.created",
      delegation: { id: "delegation_1", target: "responses", response_id: "resp_1" },
    });
    w.event({
      type: "response.event",
      delegation_id: "delegation_1",
      event: { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    });
    w.event({ type: "response.event", delegation_id: "delegation_1", event: call("status") });
    await flush();
    expect(count(w.wires, "response.create")).toBe(0);
    const terminal = {
      type: "response.event",
      delegation_id: "delegation_1",
      event: {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          output: [],
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
            output_tokens: 4,
          },
        },
      },
    };
    w.event(terminal);
    w.event(terminal);
    await flush();
    expect(w.wires.filter((wire) => String(wire["type"]).startsWith("response."))).toEqual([
      {
        type: "response.item.create",
        event_id: expect.any(String),
        item: { type: "function_call_output", call_id: "status", output: '{"ok":true,"result":"Checked status"}' },
      },
      { type: "response.create", event_id: expect.any(String) },
    ]);
    const ledger = JSON.parse(readFileSync(join(w.directory, "usage.json"), "utf8"));
    expect(ledger.days["1970-01-01"].backendUsd).toBeCloseTo(0.0001045, 10);
  } finally {
    await w.cleanup();
  }
});

test.each([false, true])("session.closed blocks queued writes before WebSocket close (local=%s)", async (local) => {
  const first = Promise.withResolvers<{ ok: boolean; result: string }>();
  let calls = 0;
  const w = liveWorld(async () => {
    calls++;
    return calls === 1 ? first.promise : { ok: true, result: "Must not execute" };
  });
  try {
    w.open();
    w.event({ type: "session.started", session: { id: "live_fixture" } });
    w.event({
      type: "session.delegation.created",
      delegation: { id: "delegation_1", target: "responses", response_id: "resp_1" },
    });
    for (const id of ["first", "queued"])
      w.event({ type: "response.event", delegation_id: "delegation_1", event: call(id, "post_note", { text: id }) });
    await flush();
    expect(calls).toBe(1);
    if (local) w.session.close("owner left");
    w.event({ type: "session.closed", session: { id: "live_fixture" }, usage: { seconds: 4 } });
    expect(w.session.state).toBe("closing");
    expect(w.closes()).toBe(1);
    first.resolve({ ok: true, result: "The already executing note finished" });
    await flush();
    expect(calls).toBe(1);
    expect(count(w.wires, "response.item.create")).toBe(0);
    expect(count(w.wires, "response.create")).toBe(0);
    expect(count(w.wires, "session.close")).toBe(local ? 1 : 0);
    expect(w.session.failed).toBe(!local);
    w.time(17_001);
    w.session.tick();
    await w.session.done;
    expect(w.session.state).toBe("closed");
    const ledger = JSON.parse(readFileSync(join(w.directory, "usage.json"), "utf8"));
    expect(ledger.days["1970-01-01"].liveSeconds).toBeCloseTo(16.001, 6);
  } finally {
    first.resolve({ ok: true, result: "Settled" });
    await w.cleanup();
  }
});

test("a failed final usage write cannot send a second close or strand the provider socket", async () => {
  const w = liveWorld();
  try {
    w.open();
    w.event({ type: "session.started", session: { id: "live_fixture" } });
    mkdirSync(join(w.directory, "usage.json.tmp"));
    w.event({ type: "session.closed", usage: { seconds: 4 }, session: { id: "live_fixture" } });
    await flush();
    expect(w.session.state).toBe("closing");
    expect(w.session.failed).toBe(true);
    expect(w.closes()).toBe(1);
    expect(count(w.wires, "session.close")).toBe(0);
  } finally {
    await w.cleanup();
  }
});

test("delegation validation failures hold paid work without automatic configuration repair", async () => {
  const f = fixture();
  try {
    const current = await f.start();
    current.handlers.event(
      parseLiveEvent({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "responses_validation_failed",
          client_event_id: current.wires[0]!["event_id"],
          message: "Delegation settings were rejected",
        },
      }),
    );
    expect(count(current.wires, "session.close")).toBe(1);
    current.handlers.closed();
    await flush();
    f.engine.ownerPresence(false);
    f.engine.ownerPresence(true);
    for (let i = 0; i < 20; i++) f.engine.pcm(voiced());
    expect(f.sessions).toHaveLength(1);
    expect(f.failedSummaries).toEqual([true]);
    expect(f.notices.join("\n")).toContain("Voice is held");
    expect(count(current.wires, "session.update")).toBe(0);
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});
