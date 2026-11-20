import { expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FlowDeps, watchTick } from "../src/done-flow.ts";
import { paneStatePath, readPaneState, writePaneState } from "../src/lane-state.ts";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { openOwes } from "../src/owes.ts";
import { parkLane } from "../src/park.ts";
import { Registry, sessionOf, withStatus } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

const posix = test.skipIf(process.platform === "win32");

posix(
  "public REST intake holds the exact shared lane message until native close recovery",
  verifyCloseRecovery,
  20_000,
);

async function verifyCloseRecovery() {
  const f = await lifecycleFixture();
  const { dir } = f.state;
  const message = ownerMessage("101");
  const { id, channel_id: channel, author, content } = message;
  if (!content) throw new Error("expected owner test content");
  const historyPath = `/channels/${channel}/messages`;
  const polls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET") {
        if (url.pathname === "/users/@me") return Response.json({ id: "99", bot: true });
        if (url.pathname === "/applications/@me") return Response.json({ flags: 1 << 19 });
        if (url.pathname === historyPath && url.search === "?limit=1") return Response.json([message]);
        if (url.pathname === historyPath && url.search === "?limit=100") {
          polls.push(id);
          return Response.json([message]);
        }
      }
      return new Response("unexpected fixture request", { status: 400 });
    },
  });
  try {
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: dir, runtime: "herdr", hooks: {} }));
    const cursor = fileDiscordInboundStore(dir, channel);
    cursor.save("100");
    const ready = `INBOUND_READY discord owner=${author.id} channel=${channel} bot=99`;
    const ownerLine = `INBOUND discord ${channel} ${id} from=owner ref=- ${JSON.stringify(content)}`;
    const poll = async () => {
      const argv = [process.execPath, join(import.meta.dir, "../src/cli.ts"), "inbound", "discord", "--loop", "0"];
      const child = Bun.spawn(argv, {
        env: {
          HOME: dir,
          PATH: "/usr/bin:/bin",
          DORI_CONFIG: config,
          DORI_STATE_DIR: dir,
          DORI_DISCORD_API_BASE: `http://127.0.0.1:${server.port}`,
          DORI_DISCORD_TOKEN: "synthetic-loopback-token",
          DORI_DISCORD_OWNER_ID: author.id,
          DORI_DISCORD_CHANNEL_ID: channel,
          DORI_DISCORD_THREADS: "off",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      return { lines: out.trim().split("\n"), cursor: cursor.load(), owes: openOwes(dir, Date.now()) };
    };

    const parked = await parkLane(f.deps, f.lane, "wait");
    expect(parked.code).toBe(0);
    const reopened = await reopenLane(f.deps, parked.lane);
    expect(reopened.code).toBe(0);
    expect(reopened.lane.lifecycleEpoch).toBeDefined();
    const ref = sessionOf(reopened.lane)!;
    const pane = readPaneState(dir, ref.id)!;
    expect(reopened.lane.session).toBe(f.session);
    expect(pane.sessionId).toBe(f.session);
    writePaneState(dir, { ...pane, discordLaneKey: reopened.lane.key, discordLaneInbox: true });
    const at = new Date(f.deps.clock.now()).toISOString();
    const claim = withStatus(reopened.lane, "done-claimed", "merge verified", at, {
      thread: `discord:${channel}`,
      claim: { at, evidence: "merge verified", emitted: true },
    });
    await f.deps.registry.write(claim);
    f.world.calls.length = 0;
    const deps: FlowDeps = {
      ...f.deps,
      config: { ...f.deps.config, closeAfterMin: 5 },
      clock: { ...f.deps.clock, now: () => f.deps.clock.now() + 6 * 60_000 },
    };
    const isPresent = () => f.world.panes.some((entry) => entry.pane_id === ref.id);
    const closeCalls = () =>
      f.world.calls.filter(([cmd, scope, verb]) => cmd === "herdr" && scope === "pane" && verb === "close");
    const lostReadback = "fixture lost the post-close pane list";
    let removed = false;
    const interrupted = await watchTick({
      ...deps,
      run: async (argv, options) => {
        const [cmd, scope, verb, target] = argv;
        if (removed && cmd === "herdr" && scope === "pane" && verb === "list")
          return { code: 1, out: "", err: lostReadback };
        const result = await deps.run(argv, options);
        if (cmd === "herdr" && scope === "pane" && verb === "close" && target === ref.id && result.code === 0) {
          removed = !isPresent();
          unlinkSync(paneStatePath(dir, ref.id));
        }
        return result;
      },
    });
    expect(interrupted).toEqual([expect.stringContaining(`LANE_HELD ${claim.key}:`)]);
    expect(interrupted[0]).toContain(lostReadback);
    expect(isPresent()).toBe(false);
    expect(readPaneState(dir, ref.id)).toBeNull();
    expect(closeCalls()).toEqual([["herdr", "pane", "close", ref.id]]);
    const registry = new Registry(dir);
    const held = await registry.read(claim.key);
    expect(held).toMatchObject({
      status: "done-claimed",
      thread: `discord:${channel}`,
      session: claim.session,
      sessionRef: ref,
      nativeCloseIntent: { ref, session: claim.session, epoch: claim.lifecycleEpoch },
    });
    expect(held?.receipt).toBeUndefined();

    const pending = await poll();
    expect(polls).toEqual([id]);
    expect(pending.lines[0]).toBe(ready);
    expect({
      ownerLines: pending.lines.filter((line) => line.startsWith("INBOUND ")),
      cursor: pending.cursor,
      owes: pending.owes,
    }).toEqual({
      ownerLines: [],
      cursor: "100",
      owes: [],
    });
    expect(await registry.read(claim.key)).toEqual(held);

    expect(await watchTick({ ...deps, registry })).toEqual([expect.stringContaining(`LANE_CLOSED ${claim.key} `)]);
    const closed = await registry.read(claim.key);
    expect(closed).toMatchObject({
      status: "closed",
      thread: `discord:${channel}`,
      sessionRef: ref,
      session: claim.session,
      lifecycleEpoch: claim.lifecycleEpoch,
      receipt: { outcome: "done", cleanup: [`pane ${ref.id} closed`] },
    });
    expect(closed?.nativeCloseIntent).toBeUndefined();
    expect(closeCalls()).toEqual([["herdr", "pane", "close", ref.id]]);

    const released = await poll();
    expect(released.lines).toEqual([ready, ownerLine]);
    expect(released.cursor).toBe(id);
    expect(released.owes).toEqual([
      { id: `${channel}:${id}`, channel, message: id, text: content, at: expect.any(Number) },
    ]);
    expect(await poll()).toEqual({ lines: [ready], cursor: id, owes: released.owes });
    expect(polls).toEqual([id, id]); // The last run only probes the already-checkpointed head.
  } finally {
    server.stop(true);
    f.state.done();
  }
}
