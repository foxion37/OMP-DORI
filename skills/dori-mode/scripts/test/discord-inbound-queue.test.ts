import { expect, spyOn, test } from "bun:test";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import { discordInboundLive } from "../src/messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";
import { settle } from "./discord-inbound-live-fakes.ts";
import { FakeGateway, gatewayTimers } from "./discord-presence-fakes.ts";
import { withState } from "./fakes.ts";

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

for (const [mode, threads] of [
  ["channel only", false],
  ["parent following", true],
] as const)
  posix(`invalid and known-unwatched dispatches never enter the blocked disk queue (${mode})`, async () => {
    const state = withState();
    const queue = discordInboundQueue(state.dir);
    const hold = Promise.withResolvers<void>();
    const rest = discordRestWorld([]);
    const cursor = memoryDiscordCursor("100");
    const intake = await discordInbound(rest.discord, () => cursor.store, {
      ownerId: "10",
      channelIds: ["20"],
      threads,
    });
    if (threads) expect(await intake.resolveThread("21", new AbortController().signal)).toBeUndefined();
    rest.state.blocked.set("/channels/20/messages", hold.promise);
    const socket = new FakeGateway("offline");
    const live = discordInboundLive(
      intake,
      () => socket,
      "offline",
      gatewayTimers().clock,
      () => {
        throw new Error("unexpected emit");
      },
      () => {},
      queue,
    );
    const pushes = spyOn(queue, "push");
    try {
      socket.hello();
      socket.ready(1);
      await settle();
      pushes.mockClear();
      for (let i = 1; i <= 2_000; i++)
        socket.receive({ op: 0, t: "MESSAGE_CREATE", s: i + 1, d: ownerMessage(String(i), { channel_id: "21" }) });
      expect(rest.requests.filter((request) => new URL(request.url).pathname.endsWith("/channels/21"))).toHaveLength(
        threads ? 1 : 0,
      );
      for (const d of [null, {}, { id: "bad", channel_id: "20" }, { id: "2001", channel_id: "bad" }])
        socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2002, d });
      expect(pushes).toHaveBeenCalledTimes(0);
      socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2003, d: ownerMessage("2001", { author: { id: "11" } }) });
      expect(pushes).toHaveBeenCalledTimes(1);
      expect(cursor.store.load()).toBe("100");
      hold.resolve();
      await settle();
      expect(cursor.store.load()).toBe("2001");
    } finally {
      pushes.mockRestore();
      hold.resolve();
      live.close();
      await live.done;
      queue.close();
      state.done();
    }
  });

posix("a rejected same-process consumer preserves the first queue's lock against other processes", async () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  try {
    queue.push("message", ownerMessage("101"));
    expect(() => discordInboundQueue(state.dir)).toThrow("other intake processes");
    const source = JSON.stringify(join(import.meta.dir, "../src/messenger/discord-inbound-queue.ts"));
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        import { discordInboundQueue } from ${source};
        try {
          const queue = discordInboundQueue(process.env.DORI_QUEUE_STATE);
          queue.push("message", { id: "102", channel_id: "20" });
          queue.close();
        } catch (error) {
          console.log(error.message);
          process.exitCode = 1;
        }
      `,
      ],
      { env: { DORI_QUEUE_STATE: state.dir }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout).text()).toContain("queue storage failed");
    expect(await new Response(child.stderr).text()).toBe("");
    expect(JSON.parse(queue.first()!.payload).id).toBe("101");
    queue.remove(queue.first()!.id);
    expect(queue.first()).toBeNull();
  } finally {
    queue.close();
    state.done();
  }
});

for (const kind of ["symlink", "corrupt"] as const) {
  posix(`a ${kind} queue produces a sanitized state error`, () => {
    const state = withState();
    try {
      const dir = join(state.dir, "discord-inbound");
      mkdirSync(dir, { mode: 0o700 });
      const path = join(dir, "gateway.sqlite");
      if (kind === "symlink") symlinkSync(join(state.dir, "missing"), path);
      else writeFileSync(path, "not a database", { mode: 0o600 });
      expect(() => discordInboundQueue(state.dir)).toThrow(MessengerError);
      expect(() => discordInboundQueue(state.dir)).toThrow(
        kind === "symlink" ? "queue must be a private regular file" : "queue storage failed",
      );
    } finally {
      state.done();
    }
  });
}

posix(
  "the 256 MiB database budget stops insertion and preserves already queued records",
  () => {
    const state = withState();
    const queue = discordInboundQueue(state.dir);
    try {
      const content = "x".repeat(1024 * 1024);
      expect(() => {
        for (let i = 1; i <= 300; i++) queue.push("message", ownerMessage(String(i), { content }));
      }).toThrow("256 MiB queue limit");
      expect(JSON.parse(queue.first()!.payload).id).toBe("1");
      const path = join(state.dir, "discord-inbound/gateway.sqlite");
      expect(statSync(path).size).toBeLessThanOrEqual(256 * 1024 * 1024);
      expect(statSync(`${path}-wal`).size).toBeLessThan(16 * 1024 * 1024);
      queue.remove(queue.first()!.id);
      expect(queue.first()!.id).toBe(2);
    } finally {
      queue.close();
      state.done();
    }
  },
  30_000,
);

posix("a process killed after a WAL commit leaves its pending message recoverable", async () => {
  const state = withState();
  const source = JSON.stringify(join(import.meta.dir, "../src/messenger/discord-inbound-queue.ts"));
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { discordInboundQueue } from ${source};
    const queue = discordInboundQueue(process.env.DORI_QUEUE_STATE);
    queue.push("message", { id: "101", channel_id: "20" });
    process.stdin.resume();
    console.log("queued");
  `,
    ],
    { env: { DORI_QUEUE_STATE: state.dir }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const output = await reader.read();
    expect(new TextDecoder().decode(output.value)).toContain("queued");
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
    const queue = discordInboundQueue(state.dir);
    try {
      expect(JSON.parse(queue.first()!.payload).id).toBe("101");
    } finally {
      queue.close();
    }
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    state.done();
  }
});

posix("admission cursors retain canonical decimal validation without writing a failed record", () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  try {
    for (const after of ["-1", "01", "1e3", "18446744073709551616"])
      expect(() => queue.push("message", ownerMessage("105"), after)).toThrow("admission cursor is invalid");
    expect(queue.first()).toBeNull();
    queue.push("message", ownerMessage("105"), "0");
    expect(queue.first()?.admittedAfter).toBe("0");
  } finally {
    queue.close();
    state.done();
  }
});
