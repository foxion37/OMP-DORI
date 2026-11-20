import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { discordLaneMonitor } from "../src/discord-lane-monitor.ts";
import { laneState } from "./fakes.ts";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { openDiscordLaneInbox } from "../src/messenger/discord-lane-inbox.ts";
import { Discord } from "../src/messenger/discord.ts";
import { fetchHttp } from "../src/messenger/http.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

const identity = { bot: "721", owner: "941" };
const posix = test.skipIf(process.platform === "win32");

posix("a restarted shared monitor posts only its own saved reply as a Discord reply, once", async () => {
  const f = await lifecycleFixture();
  const message = ownerMessage("301");
  const channel = message.channel_id;
  await f.deps.registry.write({ ...f.lane, thread: `discord:${channel}` });
  const requests: { readonly path: string; readonly body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ id: "401", channel_id: channel });
    },
  });
  const db = openDiscordLaneInbox(f.state.dir);
  try {
    db.add(
      f.session,
      { channel, message: message.id, text: "question", reference: null, replyTo: null, attachments: [] },
      {
        reply: identity,
      },
    );
    db.acknowledge(f.session, channel, message.id);
    db.enqueueReply(f.session, channel, { id: message.id, parts: ["answer"] });
    const client = new Discord(fetchHttp, f.deps.clock, "fixture-bot", `http://127.0.0.1:${server.port}`);

    await discordLaneMonitor(f.deps, client, { ...identity, owner: "942" })(db, [channel]);
    const receiver = discordLaneMonitor(f.deps, client, identity);
    await receiver(db, ["222"]);
    await receiver(db, [channel]);
    await discordLaneMonitor(f.deps, client, identity)(db, [channel]);

    expect(requests).toEqual([
      {
        path: `/channels/${channel}/messages`,
        body: {
          content: "answer",
          allowed_mentions: { parse: [], replied_user: false },
          nonce: expect.stringMatching(/^[a-f0-9]{24}$/),
          enforce_nonce: true,
          message_reference: { message_id: "301", fail_if_not_exists: true },
        },
      },
    ]);
    expect(db.nextReply(f.session, channel, identity)).toBeNull();
  } finally {
    db.close();
    server.stop(true);
    f.state.done();
  }
});

posix("a deleted Discord original drops all of its reply parts without blocking the next request", async () => {
  const f = await lifecycleFixture();
  const channel = ownerMessage("301").channel_id;
  await f.deps.registry.write({ ...f.lane, thread: `discord:${channel}` });
  const attempted: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = (await request.json()) as { message_reference: { message_id: string } };
      const original = body.message_reference.message_id;
      attempted.push(original);
      if (original === "301") return Response.json({ message: "Unknown Message", code: 10008 }, { status: 404 });
      return Response.json({ id: "401", channel_id: channel });
    },
  });
  const db = openDiscordLaneInbox(f.state.dir);
  try {
    for (const original of ["301", "302"]) {
      db.add(
        f.session,
        { channel, message: original, text: "question", reference: null, replyTo: null, attachments: [] },
        { reply: identity },
      );
      db.enqueueReply(f.session, channel, { id: original, parts: original === "301" ? ["first", "second"] : ["next"] });
    }
    const client = new Discord(fetchHttp, f.deps.clock, "fixture-bot", `http://127.0.0.1:${server.port}`);
    const deliver = discordLaneMonitor(f.deps, client, identity);
    await deliver(db, [channel]);
    await deliver(db, [channel]);
    await deliver(db, [channel]);
    expect(attempted).toEqual(["301", "302"]);
    expect(db.nextReply(f.session, channel, identity)).toBeNull();
  } finally {
    db.close();
    server.stop(true);
    f.state.done();
  }
});

posix.each([false, true])("owner ingress queues a paused lane with auto-reply opt-in %s", async (enabled) => {
  const f = await lifecycleFixture();
  const { dir } = f.state;
  const message = ownerMessage("301");
  const channel = message.channel_id;
  const config = join(dir, "config.json");
  const reacted = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "PUT" && pathname.startsWith(`/channels/${channel}/messages/301/reactions/`)) {
        reacted.resolve();
        return new Response(null, { status: 204 });
      }
      if (pathname === "/users/@me") return Response.json({ id: identity.bot, bot: true });
      if (pathname === "/applications/@me") return Response.json({ flags: 1 << 19 });
      if (pathname === `/channels/${channel}/messages`) return Response.json([message]);
      return new Response(null, { status: 404 });
    },
  });
  const inbox = openDiscordLaneInbox(dir);
  try {
    await f.deps.registry.write({ ...f.lane, thread: `discord:${channel}`, status: "paused" });
    laneState(dir, "w1:p7", { sessionId: f.session, pid: 0, discordLaneInbox: true, goal: { status: "paused" } });
    writeFileSync(config, JSON.stringify({ stateDir: dir, runtime: "herdr" }));
    fileDiscordInboundStore(dir, channel).save("300");
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "inbound",
        "discord",
        ...(enabled ? ["--wake-lanes"] : []),
      ],
      {
        env: {
          HOME: dir,
          PATH: "/usr/bin:/bin",
          DORI_CONFIG: config,
          DORI_DISCORD_API_BASE: `http://127.0.0.1:${server.port}`,
          DORI_DISCORD_TOKEN: "synthetic-loopback-token",
          DORI_DISCORD_OWNER_ID: message.author.id,
          DORI_DISCORD_CHANNEL_ID: channel,
          DORI_DISCORD_THREADS: "off",
        },
        stdout: "ignore",
        stderr: "pipe",
        timeout: 3_500,
      },
    );
    const errors = new Response(child.stderr).text();
    try {
      await Promise.race([
        reacted.promise,
        child.exited.then(async (code) => {
          throw new Error(`Receiver stopped with ${code}: ${await errors}`);
        }),
      ]);
      expect(inbox.next(f.session, channel)).toMatchObject({ id: "301" });
      expect(inbox.pendingSessions({ bot: identity.bot, owner: message.author.id })).toEqual(
        enabled ? [{ session: f.session, channel, hasInput: true }] : [],
      );
    } finally {
      child.kill();
      await child.exited;
    }
  } finally {
    inbox.close();
    server.stop(true);
    f.state.done();
  }
});
