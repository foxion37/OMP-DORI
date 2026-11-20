import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../src/checkpoint-lock.ts";
import { discordInbound, formatDiscordInbound } from "../src/messenger/discord-inbound.ts";
import type { DiscordInbound } from "../src/messenger/discord-inbound-api.ts";
import { discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { openOwes, recordOwes } from "../src/owes.ts";
import { discordRestWorld, ownerMessage } from "./discord-inbound-fakes.ts";
import { settle } from "./discord-inbound-live-fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { withState } from "./fakes.ts";

const posix = test.skipIf(process.platform === "win32");

const world = async (
  mode: "sync" | "message",
  emit: (message: DiscordInbound, signal: AbortSignal | undefined, root: string) => Promise<void>,
) => {
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  queue.storeFor("20").save("100");
  if (mode === "sync") {
    queue.push("sync");
    queue.push("message", ownerMessage("102"), "100");
  }
  const rest = discordRestWorld(mode === "sync" ? [ownerMessage("100"), ownerMessage("101")] : [ownerMessage("100")]);
  const intake = await discordInbound(rest.discord, queue.storeFor, { ownerId: "10", channelIds: ["20"] });
  const socket = new FakeGateway("offline");
  const live = discordInboundLive(
    intake,
    () => socket,
    "offline",
    gatewayTimers().clock,
    (message, signal) => emit(message, signal, state.dir),
    () => {},
    queue,
  );
  const outcome = live.done.then(
    () => undefined,
    (error: unknown) => error,
  );
  return {
    state,
    queue,
    live,
    socket,
    outcome,
    async dispatch() {
      socket.hello();
      socket.ready();
      // Finish the initial quiet sync before testing the direct accept path.
      for (let turn = 0; turn < 30 && queue.first(); turn++) await settle();
      expect(queue.first()).toBeNull();
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: ownerMessage("101") });
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 5, d: ownerMessage("102") });
    },
    async close() {
      live.close();
      await outcome;
      queue.close();
      state.done();
    },
  };
};

for (const mode of ["sync", "message"] as const) {
  for (const ending of ["close", "terminal"] as const) {
    posix(`${mode}: ${ending} cancels a held-lock ledger wait and retains payload/cursor/ack state`, async () => {
      const entered = Promise.withResolvers<void>();
      const begin = Promise.withResolvers<void>();
      const received: string[] = [];
      const w = await world(mode, async (message, signal, root) => {
        await begin.promise;
        entered.resolve();
        await recordOwes(root, formatDiscordInbound(message), 1000, signal);
        signal?.throwIfAborted();
        received.push(message.message);
      });
      mkdirSync(join(w.state.dir, "owes"), { recursive: true, mode: 0o700 });
      const release = takeLock(join(w.state.dir, "owes", "inbound.jsonl.lock"), Date.now(), (m) => new Error(m));
      if (typeof release === "string") throw new Error(release);
      try {
        if (mode === "message") await w.dispatch();
        begin.resolve();
        await entered.promise;
        const pending = w.queue.first();
        expect(pending).not.toBeNull();
        if (ending === "close") w.live.close();
        else w.socket.disconnect(4014);
        const error = await w.outcome;
        if (ending === "close") expect(error).toBeUndefined();
        else {
          expect(error).toBeInstanceOf(MessengerError);
          if (!(error instanceof MessengerError)) throw new Error("missing terminal Gateway error");
          expect(error.status).toBe(4014);
        }
        expect(received).toEqual([]);
        expect(openOwes(w.state.dir, 1001)).toEqual([]);
        expect(w.queue.storeFor("20", false).load()).toBe("100");
        expect(w.queue.first()).toEqual(pending);
        w.socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 6, d: ownerMessage("103") });
        await settle();
        expect(received).toEqual([]);
        expect(w.queue.first()).toEqual(pending);
      } finally {
        begin.resolve();
        w.live.close();
        release();
        await w.close();
      }
    });
  }
}

for (const fault of [new Error("context failed during close"), new DOMException("unrelated abort", "AbortError")]) {
  posix(`close still propagates a genuine non-owned fault: ${fault.message}`, async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const w = await world("message", async () => {
      entered.resolve();
      await finish.promise;
      throw fault;
    });
    try {
      await w.dispatch();
      await entered.promise;
      w.live.close();
      finish.resolve();
      expect(await w.outcome).toBe(fault);
      expect(w.queue.storeFor("20", false).load()).toBe("100");
      expect(w.queue.first()).not.toBeNull();
    } finally {
      finish.resolve();
      await w.close();
    }
  });
}
