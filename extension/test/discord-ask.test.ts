import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeDiscordAskReply } from "../../skills/dori-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import { DiscordAsk } from "../discord-ask.ts";
import { until } from "./fake-pi.ts";

const html = '<form><label>Which backend? <input name="backend" required></label></form>';
const room = "109867692300000023";
const owner = "109867692300000024";
const question = "109867692300000025";
const first = "109867692300000026";
const next = "109867692300000027";
const event = { toolName: "ask", toolCallId: "tool-ask-1", input: { html } };

// The bridge verifies POSIX ownership and mode on the token and reply mailbox.
const posix = test.skipIf(process.platform === "win32");

for (const winner of ["Discord", "terminal"] as const) {
  posix(`${winner} answers the native ASK once and closes the other path`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cataly-discord-ask-"));
    const tokenFile = join(root, "bot-token");
    const previous = process.env["DORI_DISCORD_API_BASE"];
    const posts: Array<Record<string, unknown>> = [];
    const questions = Promise.withResolvers<void>();
    const editResponse = Promise.withResolvers<void>();
    const invalid = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method === "PATCH" && path === `/channels/${room}/messages/${question}`) {
          posts.push((await req.json()) as Record<string, unknown>);
          questions.resolve();
          await editResponse.promise;
          return Response.json({ id: question });
        }
        if (req.method !== "POST" || path !== `/channels/${room}/messages`)
          return new Response("unexpected route", { status: 404 });
        if (req.headers.get("authorization") !== "Bot synthetic-ask-token")
          return new Response("wrong test token", { status: 401 });
        posts.push((await req.json()) as Record<string, unknown>);
        if (posts.length > 1) invalid.resolve();
        return Response.json({ id: posts.length === 1 ? question : next });
      },
    });
    process.env["DORI_DISCORD_API_BASE"] = `http://127.0.0.1:${server.port}`;
    writeFileSync(tokenFile, "synthetic-ask-token\n", { mode: 0o600 });
    writeFileSync(
      join(root, "discord-ask.json"),
      JSON.stringify({ sessions: { lane: { channel: room, owner, tokenFile } } }),
      { mode: 0o600 },
    );
    const terminalAnswer = Promise.withResolvers<{ data: { backend: string } } | undefined>();
    let terminalSignal: AbortSignal | undefined;
    const notices: string[] = [];
    const ui = {
      async formDialog(_form: string, options?: { signal?: AbortSignal }) {
        terminalSignal = options?.signal;
        return terminalAnswer.promise;
      },
      notify(message: string) {
        notices.push(message);
      },
    };
    const bridge = new DiscordAsk();
    const original = ui.formDialog;
    try {
      bridge.arm({ ...event, toolName: "bash" }, ui, root, "lane");
      expect(ui.formDialog).toBe(original);
      bridge.arm(event, ui, root, "other-lane");
      expect(ui.formDialog).toBe(original);
      bridge.arm(event, ui, root, "lane");
      const result = ui.formDialog(html);
      await questions.promise;
      expect(posts[0]?.["content"]).not.toContain("Which backend?");
      expect(posts[1]?.["content"]).toContain("Which backend?");
      expect(posts[1]?.["allowed_mentions"]).toEqual({ parse: [], replied_user: false });
      const ownerFile = join(root, "discord-ask-replies", `${room}-${question}`, "owner");
      expect(existsSync(ownerFile)).toBe(true);
      const reply = { channel: room, reference: question, message: first, text: "sqlite" };
      if (winner === "Discord") {
        expect(routeDiscordAskReply(root, reply, question)).toBe(false);
        expect(routeDiscordAskReply(root, { ...reply, text: '{"unknown":"no"}' }, owner)).toBe(true);
        editResponse.resolve();
        await invalid.promise;
        expect(posts[2]?.["content"]).toContain("not accepted");
        expect(routeDiscordAskReply(root, { ...reply, message: next }, owner)).toBe(true);
        expect(await result).toMatchObject({ data: { backend: "sqlite" } });
        expect(terminalSignal?.aborted).toBe(true);
      } else {
        terminalAnswer.resolve({ data: { backend: "local" } });
        expect(await result).toEqual({ data: { backend: "local" } });
        editResponse.resolve();
        const dir = join(root, "discord-ask-replies", `${room}-${question}`);
        await until(() => existsSync(join(dir, "closed")));
        expect(routeDiscordAskReply(root, reply, owner)).toBe(true);
        expect(existsSync(join(dir, `reply-${first}`))).toBe(false);
      }
      expect(ui.formDialog).toBe(original);
      expect(notices).toEqual([]);
    } finally {
      bridge.clear();
      editResponse.resolve();
      terminalAnswer.resolve(undefined);
      if (previous === undefined) delete process.env["DORI_DISCORD_API_BASE"];
      else process.env["DORI_DISCORD_API_BASE"] = previous;
      server.stop(true);
      rmSync(root, { recursive: true });
    }
  });
}
