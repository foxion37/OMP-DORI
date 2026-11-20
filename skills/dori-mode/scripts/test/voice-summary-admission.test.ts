import { expect, test } from "bun:test";
import { Discord } from "../src/messenger/discord.ts";
import { summarizeVoice } from "../src/voice/summary.ts";
import { flush, settings } from "./voice-fixture.ts";
import { fixture, voiced } from "./voice-session-fixture.ts";

test.each(["429", "500", "network", "malformed", "success", "cap", "post-failure"])(
  "F1 finalization holds admission through provider and Discord completion (%s)",
  async (outcome) => {
    const provider = Promise.withResolvers<Response>();
    const posting = Promise.withResolvers<void>();
    let requests = 0;
    let posts = 0;
    const discord = new Discord(
      async () => {
        posts++;
        await posting.promise;
        return { status: outcome === "post-failure" ? 403 : 200, headers: {}, body: '{"id":"summary"}' };
      },
      { now: () => 1000, sleep: async () => {} },
      "synthetic-discord",
    );
    const config = settings({ backendUsdCap: 0.015 });
    const f = fixture(config, async (session) =>
      summarizeVoice(session, config, f.usage, "synthetic-provider", discord, async () => {
        requests++;
        return provider.promise;
      }),
    );
    const tryAdmission = () => {
      f.engine.ownerPresence(false);
      f.engine.ownerPresence(true);
      for (let i = 0; i < 20; i++) f.engine.pcm(voiced());
    };
    try {
      const first = await f.start();
      first.handlers.event({ type: "session.input_transcript.delta", delta: "owner request" });
      f.engine.ownerPresence(false);
      first.handlers.closed();
      await flush();
      expect(requests).toBe(1);
      tryAdmission();
      const whileProviderPending = f.sessions.length;
      if (outcome === "network") provider.reject(new Error("offline transport failure"));
      else if (outcome === "429" || outcome === "500")
        provider.resolve(new Response("provider failure", { status: Number(outcome) }));
      else
        provider.resolve(
          Response.json({
            output:
              outcome === "malformed"
                ? []
                : [{ type: "message", id: "summary", content: [{ type: "output_text", text: "Summary" }] }],
            usage: { input_tokens: outcome === "cap" ? 200_000 : 10 },
          }),
        );
      await flush();
      expect(posts).toBe(1);
      tryAdmission();
      const whileDiscordPending = f.sessions.length;
      posting.resolve();
      await flush();
      tryAdmission();
      expect(whileProviderPending).toBe(1);
      expect(whileDiscordPending).toBe(1);
      expect(f.sessions).toHaveLength(outcome === "success" ? 2 : 1);
      expect(requests).toBe(1);
      if (outcome === "cap") expect(f.usage.capReason()).toBe("Backend spending limit reached");
      if (outcome === "post-failure") expect(f.logs).toContain("VOICE_FINALIZATION_FAILED");
    } finally {
      provider.resolve(new Response("provider failure", { status: 429 }));
      posting.resolve();
      await flush();
      const stopped = f.engine.stop();
      for (const session of f.sessions) session.handlers.closed();
      await stopped;
      f.cleanup();
    }
  },
);
