import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeDiscordAskReply } from "../../skills/dori-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import { askOnDiscord } from "../discord-ask-remote.ts";

const channel = "109867692300000011";
const owner = "109867692300000012";
const question = "109867692300000013";
const reply = "109867692300000014";
const form = (checked: string) => `<form><p>Which action?</p>
<label><input type="radio" name="action" value="hold" ${checked}>Hold</label>
<label><input type="radio" name="action" value="continue">Continue</label></form>`;

// ASK files and the mailbox require POSIX privacy checks.
test.skipIf(process.platform === "win32").each(["timeout", "manual at deadline", "no recommendation"] as const)(
  "Discord ASK resolves correctly with %s",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "cataly-ask-timeout-"));
    const controller = new AbortController();
    const originalBase = process.env["DORI_DISCORD_API_BASE"];
    const published = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const beforeDeadline = Promise.withResolvers<void>();
    const path = `/api/v10/channels/${channel}/messages`;
    let elapsed = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => {
      started.resolve();
      if (elapsed === 179_999) beforeDeadline.resolve();
      return elapsed;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === path) return Response.json({ id: question });
        if (req.method === "PATCH" && url.pathname === `${path}/${question}`) {
          const message: { components?: unknown[] } = await req.json();
          if (message.components?.length === 0) closed.resolve();
          else published.resolve();
          return Response.json({ id: question });
        }
        return new Response(null, { status: 404 });
      },
    });
    process.env["DORI_DISCORD_API_BASE"] = `http://127.0.0.1:${server.port}/api/v10`;
    let finished = false;
    const run = askOnDiscord({
      html: form(scenario === "no recommendation" ? "" : "checked"),
      route: { channel, owner, receiverStateDir: root },
      token: "synthetic-token",
      signal: controller.signal,
      warn: () => {},
    }).then((answer) => {
      finished = true;
      return answer;
    });
    try {
      await published.promise;
      if (scenario !== "no recommendation") {
        await started.promise;
        elapsed = 179_999;
        await beforeDeadline.promise;
        expect(finished).toBe(false);
      }
      if (scenario !== "timeout") {
        expect(
          routeDiscordAskReply(root, { channel, reference: question, message: reply, text: "continue" }, owner),
        ).toBe(true);
      }
      elapsed = 180_000;
      expect(await run).toEqual(
        scenario === "timeout" ? { data: { action: "hold" }, timedOut: true } : { data: { action: "continue" } },
      );
      if (scenario === "timeout") await closed.promise;
    } finally {
      controller.abort();
      await run.catch(() => undefined);
      clock.mockRestore();
      if (originalBase === undefined) delete process.env["DORI_DISCORD_API_BASE"];
      else process.env["DORI_DISCORD_API_BASE"] = originalBase;
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
