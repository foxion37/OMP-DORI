import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../skills/cataly-mode/scripts/src/registry.ts";
import { DiscordAsk } from "../discord-ask.ts";
import { automaticDiscordAskRoute, bindAskLane } from "../discord-ask-auto.ts";
import { until } from "./fake-pi.ts";

const cli = join(import.meta.dir, "../../skills/cataly-mode/scripts/src/cli.ts");
const primary = "109867692300000031";
const headless = "00000000-0000-4000-8000-000000000002";
const secondary = "109867692300000032";
const owner = "109867692300000033";
const bot = "109867692300000034";
const question = "109867692300000035";
const token = "synthetic-automatic-ask-token";
const abandoned = "109867692300000037";
const html = '<form><label>What value? <input name="answer" required></label></form>';
const event = { toolName: "ask", toolCallId: "automatic-ask", input: { html } };

test("only the launched lane's exact native session can reuse its recorded binding", () => {
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const record = (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data });
  expect(bindAskLane(entries, "session-a", "worker", record)).toEqual({ key: "worker", sessionId: "session-a" });
  expect(entries).toEqual([
    { type: "custom", customType: "omp-cataly:discord-ask-lane", data: { key: "worker", sessionId: "session-a" } },
  ]);
  expect(bindAskLane(entries, "session-a", undefined, record)).toEqual({ key: "worker", sessionId: "session-a" });
  expect(bindAskLane(entries, "session-b", undefined, record)).toBeUndefined();
  entries.push({
    type: "custom",
    customType: "omp-cataly:discord-ask-lane",
    data: { key: "other", sessionId: "session-b" },
  });
  expect(bindAskLane(entries, "session-a", undefined, record)).toBeUndefined();
});

// The live receiver is the native monitor; it writes a POSIX-private cursor and receiver lease. Its route carries the
// process identity discord-ask-receiver.ts reads: procfs on Linux, libproc on macOS.
const nativeBinary = process.env["CATALY_DISCORD_NATIVE_BIN"];
const posix = test.skipIf(process.platform === "win32" || !nativeBinary || nativeBinary === "off");
posix.each(["private file", "lead environment"] as const)(
  "live Discord accepts an owner ASK reply using %s credentials",
  verifyAutomaticAsk,
  12_000,
);

async function verifyAutomaticAsk(credential: "private file" | "lead environment") {
  const home = mkdtempSync(join(tmpdir(), "cataly-ask-auto-"));
  const state = join(home, "state");
  const config = join(home, "config.json");
  const tokenFile = join(home, "discord-token");
  const override = join(state, "discord-ask.json");
  const settings = JSON.stringify({ stateDir: state });
  const envKeys = [
    "CATALY_HOME",
    "CATALY_CONFIG",
    "CATALY_DISCORD_API_BASE",
    "CATALY_DISCORD_TOKEN",
    "CATALY_HEADLESS_ID",
  ] as const;
  const envBefore = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let publish = false;
  let replyNow = false;
  let reply = "";
  const patchResponse = Promise.withResolvers<void>();
  let holdPost: Promise<void> | undefined;
  const exposed: string[] = [];
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bot ${token}`) return new Response(null, { status: 401 });
      const path = new URL(req.url).pathname;
      if (path === "/users/@me") return Response.json({ id: bot, bot: true });
      if (path === "/applications/@me") return Response.json({ flags: 1 << 19 });
      const messages = path.match(/^\/channels\/(\d+)\/messages$/);
      if (messages && req.method === "GET") {
        const position = new URL(req.url).searchParams;
        const answer = {
          id: reply,
          type: credential === "lead environment" ? 0 : 19,
          channel_id: primary,
          author: { id: owner },
          ...(credential === "private file"
            ? { message_reference: { type: 0, channel_id: primary, message_id: question } }
            : {}),
          content: "automatic-reply",
        };
        return Response.json(
          replyNow &&
            messages[1] === primary &&
            (!position.has("before") || BigInt(position.get("before")!) > BigInt(reply))
            ? [answer]
            : [],
        );
      }
      if (messages && req.method === "POST") {
        requests.push(path);
        if (holdPost) {
          await holdPost;
          return Response.json({ id: abandoned });
        }
        return Response.json({ id: question });
      }
      if (req.method === "PATCH") {
        exposed.push(path);
        const body = (await req.json()) as { content: string };
        publish = body.content.includes("What value?");
        if (publish && credential === "lead environment") await patchResponse.promise;
        return Response.json({ id: question });
      }
      return new Response(null, { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  Object.assign(process.env, {
    CATALY_CONFIG: config,
    CATALY_HOME: home,
    CATALY_DISCORD_API_BASE: base,
    CATALY_DISCORD_TOKEN: credential === "lead environment" ? token : "nonmatching-fixture-token",
    CATALY_HEADLESS_ID: headless,
  });
  mkdirSync(state, { mode: 0o700 });
  if (credential === "private file") writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  writeFileSync(config, settings, { mode: 0o600 });
  const inbound = (channels: string) =>
    Bun.spawn([process.execPath, cli, "inbound", "discord", "--loop", "0.001"], {
      stdout: "ignore",
      stderr: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CATALY_HOME: home,
        CATALY_CONFIG: config,
        CATALY_DISCORD_API_BASE: base,
        CATALY_DISCORD_TOKEN: token,
        CATALY_DISCORD_OWNER_ID: owner,
        CATALY_DISCORD_CHANNEL_IDS: channels,
        CATALY_DISCORD_THREADS: "off",
        CATALY_DISCORD_NATIVE_BIN: nativeBinary,
        CATALY_MESSENGER_PROFILE_DEFAULTS: "off",
        DO_NOT_TRACK: "1",
      },
    });
  const readRoute = () => automaticDiscordAskRoute(state, "cataly", "lead");
  const bridge = new DiscordAsk();
  let terminal = Promise.withResolvers<{ data: { answer: string } } | undefined>();
  const ui = {
    async formDialog(_html: string) {
      return terminal.promise;
    },
    notify() {},
  };
  let receiver = inbound(primary);
  const disconnect = Promise.withResolvers<void>();
  try {
    let route = await readRoute();
    for (let i = 0; !route && i < 180; i++) {
      await Bun.sleep(15);
      route = await readRoute();
    }
    expect(route).toMatchObject({ channel: primary, owner });
    if (credential === "lead environment") {
      process.env.CATALY_DISCORD_TOKEN = "nonmatching-fixture-token";
      expect(await readRoute()).toBeUndefined();
      process.env.CATALY_DISCORD_TOKEN = token;
    }
    expect(existsSync(override)).toBe(false);
    await bridge.arm(event, ui, state, "lead", readRoute);
    const result = ui.formDialog(html);
    await until(() => publish);
    reply = (BigInt(Date.now() - 1420070400000) << 22n).toString();
    replyNow = true;
    const cursorFile = join(state, "discord-inbound", `${primary}.json`);
    if (credential === "lead environment")
      await until(() => JSON.parse(readFileSync(cursorFile, "utf8")).cursor === reply);
    patchResponse.resolve();
    expect(await result).toMatchObject({ data: { answer: "automatic-reply" } });
    await until(() => JSON.parse(readFileSync(cursorFile, "utf8")).cursor === reply);
    expect(existsSync(join(state, "owes"))).toBe(false);
    expect(requests).toEqual([`/channels/${primary}/messages`]);
    expect(existsSync(override)).toBe(false);
    expect(readFileSync(config, "utf8")).toBe(settings);
    if (credential === "private file") expect(readFileSync(tokenFile, "utf8")).toBe(`${token}\n`);
    else expect(existsSync(tokenFile)).toBe(false);

    const localDialog = ui.formDialog;
    writeFileSync(override, JSON.stringify({ sessions: { lead: false } }), { mode: 0o600 });
    await bridge.arm(event, ui, state, "lead", readRoute);
    expect(ui.formDialog).toBe(localDialog);

    const session = "exact-lane-session";
    const registry = new Registry(state);
    const lane = {
      key: "worker",
      title: "Worker",
      thread: `discord:${primary}`,
      sessionRef: { runtime: "headless" as const, id: headless },
      brief: "fixture",
      done: "fixture",
      openedAt: "fixture",
    };
    await registry.write(lane);
    expect(await automaticDiscordAskRoute(state, "lane", session)).toBeUndefined();
    if (credential === "lead environment") {
      expect(
        await automaticDiscordAskRoute(state, "lane", session, { key: lane.key, sessionId: session }),
      ).toBeUndefined();
      writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    }
    expect(await automaticDiscordAskRoute(state, "lane", session, { key: lane.key, sessionId: session })).toMatchObject(
      { channel: primary },
    );
    await registry.write({ ...lane, session });
    expect(await automaticDiscordAskRoute(state, "lane", session)).toMatchObject({ channel: primary });
    expect(await automaticDiscordAskRoute(state, "lane", "reused-pane-session")).toBeUndefined();
    await registry.write({ ...lane, session, thread: `discord:${secondary}` });
    expect(await automaticDiscordAskRoute(state, "lane", session)).toBeUndefined();
    terminal = Promise.withResolvers<{ data: { answer: string } } | undefined>();
    holdPost = disconnect.promise;
    await bridge.arm(event, ui, state, "stop-race", readRoute);
    const stillLocal = ui.formDialog(html);
    await until(() => requests.length === 2);
    receiver.kill("SIGTERM");
    await receiver.exited;
    expect(await readRoute()).toBeUndefined();
    disconnect.resolve();
    await until(() => existsSync(join(state, "discord-ask-replies", `${primary}-${abandoned}`, "closed")));
    expect(exposed).toEqual([`/channels/${primary}/messages/${question}`]);
    terminal.resolve({ data: { answer: "terminal-fallback" } });
    expect(await stillLocal).toEqual({ data: { answer: "terminal-fallback" } });
    receiver = inbound(`${primary},${secondary}`);
    let laneRoute = await automaticDiscordAskRoute(state, "lane", session);
    for (let i = 0; !laneRoute && i < 180; i++) {
      await Bun.sleep(15);
      laneRoute = await automaticDiscordAskRoute(state, "lane", session);
    }
    expect(laneRoute).toMatchObject({ channel: secondary });
    expect(await readRoute()).toBeUndefined();
  } finally {
    disconnect.resolve();
    bridge.clear();
    terminal.resolve(undefined);
    receiver.kill("SIGTERM");
    await receiver.exited;
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}
