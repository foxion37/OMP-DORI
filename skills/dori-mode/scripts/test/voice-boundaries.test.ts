import { expect, test } from "bun:test";
import { Discord } from "../src/messenger/discord.ts";
import { voiceServerUpdate, voiceStateUpdate } from "../src/voice/discord-events.ts";
import { summarizeVoice } from "../src/voice/summary.ts";
import { VoiceUsage } from "../src/voice/usage.ts";
import { backendFixture, completed, settings, temporaryVoice } from "./voice-fixture.ts";

test("Discord adapter validates actual SDK fields without inventing missing values", () => {
  const state = {
    guild_id: "guild",
    user_id: "bot",
    session_id: "voice-session",
    channel_id: null,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_video: false,
    suppress: false,
    request_to_speak_timestamp: null,
  };
  expect(voiceStateUpdate(state)).toEqual(state);
  expect(() => voiceStateUpdate({ guild_id: "guild", user_id: "bot", channel_id: null })).toThrow();
  const server = { guild_id: "guild", token: "synthetic", endpoint: null };
  expect(voiceServerUpdate(server)).toEqual(server);
  expect(() => voiceServerUpdate({ ...server, token: 5 })).toThrow();
});

test("duplicate hosted-search and lifecycle events account usage once", async () => {
  const f = backendFixture();
  const event = {
    type: "response.output_item.done",
    item: { type: "web_search_call", id: "search1", status: "completed" },
  };
  await f.backend.event(event, "d1");
  await f.backend.event(event, "d1");
  const terminal = { ...completed("r1"), response: { id: "r1", usage: { input_tokens: 10 } } };
  await f.backend.event(terminal, "d1");
  await f.backend.event(terminal, "d1");
  expect(f.counts()).toEqual({ searches: 1, usages: 1 });
});

test("Responses summary uses configured model, stores no transcript, and posts actual outcomes", async () => {
  const tmp = temporaryVoice();
  try {
    const config = settings();
    const usage = new VoiceUsage(tmp.directory, config, () => 1000);
    const posts: unknown[] = [];
    const discord = new Discord(
      async (request) => {
        if (typeof request.body !== "string") throw new Error("Discord note must have a JSON body");
        posts.push(JSON.parse(request.body));
        return { status: 200, headers: {}, body: '{"id":"note"}' };
      },
      { now: () => 1000, sleep: async () => {} },
      "synthetic-discord",
    );
    const session = {
      inputTranscript: ["private spoken request"],
      outputTranscript: ["private spoken answer"],
      actions: [{ tool: "forward_to_lead", ok: false, result: "sent-but-unconfirmed" }],
      failed: false,
    };
    let requests = 0;
    await summarizeVoice(session, config, usage, "synthetic-openai", discord, async (url, init) => {
      requests++;
      expect(url).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: "fixture-summary", store: false, max_output_tokens: 600 });
      expect(body.input).toContain("private spoken request");
      return Response.json({
        output: [
          {
            type: "message",
            id: "summary",
            content: [{ type: "output_text", text: "The request is pending confirmation." }],
          },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      });
    });
    expect(requests).toBe(1);
    expect(JSON.stringify(posts)).toContain("sent-but-unconfirmed");
    expect(JSON.stringify(posts)).not.toContain("private spoken request");
    expect(posts[0]).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(session.inputTranscript).toHaveLength(0);
    expect(session.outputTranscript).toHaveLength(0);
  } finally {
    tmp.cleanup();
  }
});

test("a summary provider rejection makes one request and holds later paid work", async () => {
  const tmp = temporaryVoice();
  try {
    const config = settings();
    const usage = new VoiceUsage(tmp.directory, config, () => 1000);
    const discord = new Discord(
      async () => ({ status: 200, headers: {}, body: '{"id":"note"}' }),
      { now: () => 1000, sleep: async () => {} },
      "synthetic-discord",
    );
    const session = { inputTranscript: ["request"], outputTranscript: [], actions: [], failed: false };
    let requests = 0;
    await summarizeVoice(session, config, usage, "synthetic-openai", discord, async () => {
      requests++;
      return new Response("quota", { status: 429 });
    });
    expect(requests).toBe(1);
    expect(session.failed).toBe(true);
    session.inputTranscript.push("another request");
    await summarizeVoice(session, config, usage, "synthetic-openai", discord, async () => {
      throw new Error("must not call provider after failure");
    });
    expect(requests).toBe(1);
  } finally {
    tmp.cleanup();
  }
});
