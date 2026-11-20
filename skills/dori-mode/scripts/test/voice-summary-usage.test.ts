import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Discord } from "../src/messenger/discord.ts";
import { summarizeVoice } from "../src/voice/summary.ts";
import { VoiceUsage } from "../src/voice/usage.ts";
import { settings, temporaryVoice } from "./voice-fixture.ts";

// Responses can bill an incomplete response or a refusal without returning output_text.
test.each(["incomplete", "refusal", "completed"])(
  "summary accounting precedes text acceptance (%s)",
  async (outcome) => {
    const temp = temporaryVoice();
    try {
      const config = settings({ backendUsdCap: 0.00014 });
      const usage = new VoiceUsage(temp.directory, config, () => 1000);
      const posts: string[] = [];
      const discord = new Discord(
        async (request) => {
          posts.push(String(request.body));
          return { status: 200, headers: {}, body: '{"id":"summary-note"}' };
        },
        { now: () => 1000, sleep: async () => {} },
        "synthetic-discord",
      );
      const session = { inputTranscript: ["Private request"], outputTranscript: [], actions: [], failed: false };
      let requests = 0;
      await summarizeVoice(session, config, usage, "synthetic-provider", discord, async (url, init) => {
        requests++;
        expect(url).toBe("https://api.openai.com/v1/responses");
        expect(JSON.parse(String(init.body))).toMatchObject({ model: config.summaryModel, store: false });
        return Response.json({
          id: "resp_summary",
          object: "response",
          created_at: 1,
          model: config.summaryModel,
          status: outcome === "incomplete" ? "incomplete" : "completed",
          error: null,
          incomplete_details: outcome === "incomplete" ? { reason: "max_output_tokens" } : null,
          output:
            outcome === "incomplete"
              ? []
              : [
                  {
                    id: "msg_summary",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content:
                      outcome === "refusal"
                        ? [{ type: "refusal", refusal: "I cannot provide that summary." }]
                        : [{ type: "output_text", text: "The request is pending.", annotations: [] }],
                  },
                ],
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 100, cache_write_tokens: 100 },
            output_tokens: 100,
            total_tokens: 1100,
          },
        });
      });
      const ledger = JSON.parse(readFileSync(join(temp.directory, "usage.json"), "utf8"));
      expect(ledger.days["1970-01-01"].backendUsd).toBeCloseTo(0.0001435, 10);
      expect(usage.capReason()).toBe("Backend spending limit reached");
      expect(new VoiceUsage(temp.directory, config, () => 1000).capReason()).toBe(usage.capReason());
      expect(session.failed).toBe(outcome !== "completed");
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain(outcome === "completed" ? "The request is pending." : "voice is held");
      expect(posts[0]).not.toContain("Private request");
      expect(JSON.parse(posts[0]!).allowed_mentions).toEqual({ parse: [] });
      session.inputTranscript.push("Next request");
      await summarizeVoice(session, config, usage, "synthetic-provider", discord, async () => {
        requests++;
        throw new Error("Must not retry a paid summary after failure or the cap");
      });
      expect(requests).toBe(1);
    } finally {
      temp.cleanup();
    }
  },
);
