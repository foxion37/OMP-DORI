import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordAsk } from "../discord-ask.ts";
import type { AskButtonSocket } from "../discord-ask-interactions.ts";
import { until } from "./fake-pi.ts";

const channel = "109867692300000011";
const owner = "109867692300000012";
const message = "109867692300000013";
const token = "fixture-bot-token";
const app = "109867692300000014";
const html = `<form><fieldset><legend>어떻게 진행할까?</legend>
<label><input type="radio" name="action" value="hold" checked>지금은 보류</label>
<label><input type="radio" name="action" value="continue">검증 계속</label></fieldset></form>`;

// ASK files and the mailbox require POSIX privacy checks.
test.skipIf(process.platform === "win32")(
  "clicking the owner's choice resumes native ASK once and removes the buttons",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cataly-ask-button-"));
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    writeFileSync(
      join(root, "discord-ask.json"),
      JSON.stringify({ sessions: { session: { channel, owner, tokenFile } } }),
      { mode: 0o600 },
    );
    const previousBase = process.env["DORI_DISCORD_API_BASE"];
    const callbackTypes: number[] = [];
    const path = `/api/v10/channels/${channel}/messages`;
    const edits: {
      content: string;
      components?: [{ components: { label: string; custom_id: string; style: number }[] }] | [];
    }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/api/v10/interactions/")) {
          expect(req.headers.has("authorization")).toBe(false);
          const payload: { type: number } = await req.json();
          callbackTypes.push(payload.type);
          return new Response(null, { status: 204 });
        }
        if (req.headers.get("authorization") !== `Bot ${token}`) return new Response(null, { status: 401 });
        if (url.pathname === "/api/v10/applications/@me" && req.method === "GET") return Response.json({ id: app });
        if (url.pathname === path && req.method === "POST") return Response.json({ id: message });
        if (url.pathname === `${path}/${message}` && req.method === "PATCH") {
          edits.push(await req.json());
          return Response.json({ id: message });
        }
        return new Response(null, { status: 404 });
      },
    });
    process.env["DORI_DISCORD_API_BASE"] = `http://127.0.0.1:${server.port}/api/v10`;
    let receive: (frame: string) => void = () => {};
    let seq = 1;
    let intents = -1;
    let socketClosed = false;
    const open: AskButtonSocket = () => ({
      send(frame) {
        const payload: { op: number; d: { intents: number } } = JSON.parse(frame);
        if (payload.op !== 2) return;
        intents = payload.d.intents;
        queueMicrotask(() =>
          receive(
            JSON.stringify({
              op: 0,
              s: seq++,
              t: "READY",
              d: { session_id: "fixture", resume_gateway_url: "wss://gateway.discord.gg" },
            }),
          ),
        );
      },
      close() {
        socketClosed = true;
      },
      onClose() {},
      onError() {},
      onMessage(handler) {
        receive = handler;
        queueMicrotask(() => receive(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })));
      },
    });
    const click = (customId: string, actor = owner, room = channel, question = message) =>
      receive(
        JSON.stringify({
          op: 0,
          s: seq++,
          t: "INTERACTION_CREATE",
          d: {
            type: 3,
            id: `1098676923000000${30 + seq}`,
            application_id: app,
            token: "fixture-interaction-token",
            channel_id: room,
            member: { user: { id: actor } },
            message: { id: question },
            data: { component_type: 2, custom_id: customId },
          },
        }),
      );
    const bridge = new DiscordAsk(open);
    const native = Promise.withResolvers<undefined>();
    let cancelled: AbortSignal | undefined;
    const ui = {
      async formDialog(_html: string, options?: { signal?: AbortSignal }) {
        cancelled = options?.signal;
        return native.promise;
      },
      notify() {},
    };
    try {
      await bridge.arm({ toolName: "ask", toolCallId: "button", input: { html } }, ui, root, "session");
      const result = ui.formDialog(html) as Promise<unknown>;
      await until(() => edits[0]?.components?.[0]?.components.length === 2);
      const choices = edits[0]?.components?.[0]?.components;
      if (!choices?.[0] || !choices[1]) throw Error("Discord did not receive two controls");
      expect(intents).toBe(0);
      expect(choices[0]).toMatchObject({ label: expect.stringContaining("(추천)"), style: 1 });
      expect(choices[1]).toMatchObject({ label: "검증 계속", style: 2 });
      click(choices[1].custom_id, owner, "109867692300000099");
      click(choices[1].custom_id, owner, channel, "109867692300000098");
      click(choices[1].custom_id, "109867692300000097");
      await until(() => callbackTypes.length === 1);
      expect(callbackTypes).toEqual([4]);
      expect(cancelled?.aborted).toBe(false);
      click(choices[1].custom_id);
      expect(await result).toEqual({ data: { action: "continue" } });
      expect(cancelled?.aborted).toBe(true);
      expect(socketClosed).toBe(true);
      await until(() => edits[1]?.components?.length === 0);
      expect(callbackTypes).toEqual([4, 6]);
    } finally {
      bridge.clear();
      native.resolve(undefined);
      if (previousBase === undefined) delete process.env["DORI_DISCORD_API_BASE"];
      else process.env["DORI_DISCORD_API_BASE"] = previousBase;
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
