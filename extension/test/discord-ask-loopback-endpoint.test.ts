import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeDiscordAskReply } from "../../skills/cataly-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import { openDiscordAskReceiver } from "../../skills/cataly-mode/scripts/src/messenger/discord-ask-receiver.ts";
import { load, until } from "./fake-pi.ts";

test.skipIf(process.platform === "win32")(
  "flagless ASK discovers its loopback receiver and posts without opening the public Gateway",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "cataly-loopback-ask-"));
    const config = join(home, "config.json");
    const state = join(home, "state");
    const apiOverride = "http://127.0.0.1:8199/selected";
    const token = "synthetic-loopback-ask-bot";
    const [channel, owner, question, reply] = ["10", "11", "12", "13"] as const;
    const env: Readonly<Record<string, string | undefined>> = {
      CATALY_CONFIG: config,
      CATALY_HOME: home,
      CATALY_STATE_DIR: undefined,
      CATALY_DISCORD_API_BASE: apiOverride,
      CATALY_HEADLESS_ID: undefined,
      CATALY_HARNESS_ROLE: undefined,
    };
    const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    writeFileSync(config, JSON.stringify({ stateDir: state }));
    writeFileSync(join(home, "discord-token"), token, { mode: 0o600 });
    const receiver = openDiscordAskReceiver(state, token, owner, [channel], () => [channel], { apiOverride });
    receiver.refresh();
    const requestPath = `${apiOverride}/channels/${channel}/messages`;
    const calls: string[] = [];
    const previousFetch = globalThis.fetch;
    const previousSocket = globalThis.WebSocket;
    let sockets = 0;
    // Neither transport delegates to the network, including if endpoint selection regresses.
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = `${init?.method} ${String(input)}`;
        calls.push(request);
        if (request === `POST ${requestPath}` || request === `PATCH ${requestPath}/${question}`)
          return Response.json({ id: question });
        throw new Error("unexpected Discord ASK transport");
      },
      {
        preconnect() {
          throw new Error("unexpected Discord ASK connection");
        },
      },
    );
    globalThis.WebSocket = new Proxy(previousSocket, {
      construct() {
        sockets++;
        throw new Error("unexpected Discord ASK Gateway");
      },
    });
    const terminal = Promise.withResolvers<{ data: { action: string } } | undefined>();
    try {
      const pi = await load({
        session: {
          id: "loopback-ask",
          entries: [{ type: "custom", customType: "omp-cataly:role", data: "cataly" }],
        },
      });
      const original = pi.ctx;
      const ui = { ...original().ui, formDialog: (_html: string) => terminal.promise };
      pi.ctx = () => ({ ...original(), ui });
      try {
        await pi.emit("session_start");
        const html = `<form><fieldset><legend>Pick an action</legend>
<label><input type="radio" name="action" value="wait" checked>Wait</label>
<label><input type="radio" name="action" value="continue">Continue</label></fieldset></form>`;
        await pi.emit("tool_call", { toolName: "ask", toolCallId: "old-loopback", input: { html } });
        const result = ui.formDialog(html);
        await until(() => calls.includes(`PATCH ${requestPath}/${question}`));
        expect(
          routeDiscordAskReply(state, { channel, reference: question, message: reply, text: "continue" }, owner),
        ).toBe(true);
        expect(await result).toEqual({ data: { action: "continue" } });
        expect(calls[0]).toBe(`POST ${requestPath}`);
        expect(calls.filter((call) => call.startsWith("GET"))).toEqual([]);
        expect(sockets).toBe(0);
      } finally {
        terminal.resolve(undefined);
        await pi.emit("session_shutdown");
      }
    } finally {
      receiver.close();
      globalThis.WebSocket = previousSocket;
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  },
  10_000,
);
