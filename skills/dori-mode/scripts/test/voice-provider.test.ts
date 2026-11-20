import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backendInstructions, liveInstructions } from "../src/voice/prompts.ts";
import { parseLiveEvent, parseSummary, parseUsage } from "../src/voice/provider.ts";
import { voiceSettings } from "../src/voice/settings.ts";
import { VoiceUsage } from "../src/voice/usage.ts";
import { settings, temporaryVoice } from "./voice-fixture.ts";

test("voice is explicitly enabled with operator models, valid IDs and prices", () => {
  expect(() => voiceSettings(undefined)).toThrow("disabled");
  expect(() => voiceSettings({ enabled: false })).toThrow("disabled");
  expect(() => voiceSettings({ enabled: true })).toThrow("channelId");
  const cfg = settings();
  expect(cfg.apiKeyEnv).toBe("OPENAI_API_KEY");
  expect(cfg.idleCloseSec).toBe(120);
  expect(cfg.dailyMinuteCap).toBe(30);
  expect(cfg.totalMinuteCap).toBe(0);
  expect(cfg.timeZone).toBe("UTC");
  for (const patch of [
    { channelId: "" },
    { liveModel: "" },
    { prices: {} },
    { dailyMinuteCap: 0 },
    { backendUsdCap: -1 },
    { idleCloseSec: NaN },
    { webSearchUsdPerCall: -1 },
    { wakeRmsDbfs: 0 },
    { apiKeyEnv: "bad key" },
    { timeZone: "bad-zone" },
  ])
    expect(() => settings(patch)).toThrow();
});

test("documented lifecycle events parse without output arrays or granular response IDs", () => {
  expect(
    parseLiveEvent({
      type: "response.event",
      delegation_id: null,
      event: { type: "response.completed", response: { id: "r1", status: "completed" } },
    }),
  ).toEqual({
    type: "response.event",
    delegation_id: null,
    event: { type: "response.completed", response: { id: "r1" } },
  });
  const event = parseLiveEvent({
    type: "response.event",
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "item",
        call_id: "call",
        name: "get_status",
        arguments: '{"what":["lanes"],"speak_now":false}',
      },
    },
  });
  expect(event.event?.item?.call_id).toBe("call");
  expect(() => parseLiveEvent(null)).toThrow();
  expect(() => parseLiveEvent({ type: "session.output_audio.delta", delta: 5 })).toThrow();
  expect(() => parseUsage({ input_tokens: -1 })).toThrow();
  expect(
    parseSummary({
      output: [{ id: "m", type: "message", content: [{ type: "output_text", text: "A summary" }] }],
      usage: { input_tokens: 5, output_tokens: 2 },
    }),
  ).toEqual({ text: "A summary", usage: { input_tokens: 5, output_tokens: 2 } });
  expect(() => parseSummary({ output: [] })).toThrow("Empty");
});

test("usage survives restart, counts cached/written tokens and daily boundaries, never resets corrupt data", () => {
  const tmp = temporaryVoice();
  try {
    let now = Date.parse("2026-01-01T23:59:59Z");
    const cfg = settings({ dailyMinuteCap: 1, backendUsdCap: 1 });
    const usage = new VoiceUsage(tmp.directory, cfg, () => now);
    usage.started();
    usage.live(60);
    expect(usage.capReason()).toContain("Daily");
    now += 2000;
    expect(usage.capReason()).toBeUndefined();
    usage.backend(
      {
        input_tokens: 1_000_000,
        input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 100_000 },
        output_tokens: 100_000,
      },
      cfg.backendModel,
    );
    expect(usage.capReason()).toContain("Backend");
    const again = new VoiceUsage(tmp.directory, cfg, () => now);
    expect(again.capReason()).toContain("Backend");
    const data: { days: Record<string, { backendUsd: number }> } = JSON.parse(
      readFileSync(join(tmp.directory, "usage.json"), "utf8"),
    );
    expect(Object.values(data.days).reduce((n, d) => n + d.backendUsd, 0)).toBeCloseTo(1.435);
    writeFileSync(join(tmp.directory, "usage.json"), '{"days":{"invalid":{"liveSeconds":-1}}}');
    expect(() => new VoiceUsage(tmp.directory, cfg, () => now)).toThrow("Invalid");
  } finally {
    tmp.cleanup();
  }
});

test("relay wording distinguishes confirmed delivery, pending, held and unconfirmed without approving risky work", () => {
  const instructions = liveInstructions(settings());
  expect(instructions).toContain("only after the backend result explicitly confirms delivery");
  expect(instructions).toContain("While the backend is working");
  expect(instructions).toContain("If it was not sent, held or failed");
  expect(instructions).toContain("receipt is unconfirmed");
  expect(instructions).toContain("correct an earlier premature claim");
  expect(instructions).toContain("delivery of THIS request");
  expect(instructions).toContain("A not-sent statement overrides any success wording or ok:true");
  expect(instructions).toContain("Mention retrying only if the result says retries are scheduled");
  expect(instructions).toContain("Quick facts never confirm delivery");
  expect(backendInstructions(settings())).toContain("ok:true alone is not delivery confirmation");
  expect(instructions).toContain("NEVER authorized or executed by voice");
  expect(backendInstructions(settings())).toContain("Not-sent, held, failed and sent-but-unconfirmed are not delivery");
});

test("disabled CLI starts neither a provider session nor a native voice dependency", async () => {
  const tmp = temporaryVoice();
  try {
    const config = join(tmp.directory, "config.json");
    writeFileSync(config, JSON.stringify({ voice: { enabled: false } }));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "voice", "discord"], {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: tmp.directory,
        DORI_CONFIG: config,
        DORI_DISCORD_TOKEN: "not-a-real-token",
        OPENAI_API_KEY: "not-a-real-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    expect(err.trim()).toBe("Discord voice is disabled; set voice.enabled=true explicitly");
    expect(out + err).not.toContain("VOICE_SESSION_STARTED");
  } finally {
    tmp.cleanup();
  }
});
