import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { withState } from "./fakes.ts";

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

const start = (dir: string, gateway: boolean, hold = false, context?: "context" | "context-denied") => {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, runtime: "herdr", hooks: {} }));
  return Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "record-discord-gateway.ts"),
      join(import.meta.dir, "../src/cli.ts"),
      "inbound",
      "discord",
      ...(gateway ? ["--gateway"] : ["--loop", hold ? "60" : "0"]),
      ...(context ? ["--context"] : []),
    ],
    {
      env: {
        HOME: dir,
        PATH: "/usr/bin:/bin",
        DORI_CONFIG: config,
        DORI_STATE_DIR: dir,
        DORI_DISCORD_TOKEN: "synthetic-inbound-token",
        DORI_DISCORD_OWNER_ID: "10",
        DORI_DISCORD_CHANNEL_ID: "20",
        ...(hold ? { DORI_INBOUND_HOLD: "1" } : {}),
        ...(context ? { DORI_TEST_DISCORD_CASE: context } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
};

const run = async (dir: string, gateway: boolean, context?: "context" | "context-denied") => {
  const child = start(dir, gateway, false, context);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(`${out}
${err}`).not.toContain("synthetic-inbound-token");
  return { out, err, code };
};

for (const fresh of [true, false])
  for (const firstGateway of [false, true])
    for (const secondGateway of [false, true])
      posix(
        `${fresh ? "fresh" : "existing empty"} ${firstGateway ? "Gateway" : "REST"} intake excludes a second ${secondGateway ? "Gateway" : "REST"} intake`,
        async () => {
          const state = withState();
          if (!fresh) discordInboundQueue(state.dir).close();
          expect(existsSync(join(state.dir, "discord-inbound/gateway.sqlite"))).toBe(!fresh);
          const first = start(state.dir, firstGateway, true);
          try {
            const reader = first.stdout.getReader();
            const decoder = new TextDecoder();
            let seen = "";
            try {
              while (!seen.includes("INBOUND_READY discord ")) {
                const chunk = await reader.read();
                if (chunk.done) throw new Error("First intake exited before readiness");
                seen += decoder.decode(chunk.value);
              }
            } finally {
              reader.releaseLock();
            }
            expect(first.exitCode).toBeNull();
            const second = await run(state.dir, secondGateway);
            expect(first.exitCode).toBeNull();
            expect({ code: second.code, out: second.out }).toEqual({ code: 1, out: "" });
            expect(second.err.trim().split("\n")).toHaveLength(1);
            expect(second.err).toContain("other intake processes");
            first.kill("SIGTERM");
            await first.exited;
            expect(await new Response(first.stderr).text()).toBe("");
            discordInboundQueue(state.dir).close();
          } finally {
            if (first.exitCode === null) first.kill("SIGTERM");
            await first.exited;
            state.done();
          }
        },
      );

posix("public Gateway CLI backfills, emits live text, persists the cursor and closes its queue", async () => {
  const state = withState();
  try {
    const { out, err, code } = await run(state.dir, true);
    expect({ err, code }).toEqual({ err: "", code: 0 });
    expect(out).toContain("INBOUND_READY discord owner=10 channel=20 bot=99 mode=gateway");
    expect(out.split("\n").filter((line) => line.startsWith("INBOUND discord "))).toEqual([
      'INBOUND discord 20 101 from=owner ref=- "first owner text"',
      'INBOUND discord 20 103 from=owner ref=- "live owner text"',
    ]);
    expect(fileDiscordInboundStore(state.dir, "20").load()).toBe("103");
    const queue = discordInboundQueue(state.dir);
    try {
      expect(queue.first()).toBeNull();
    } finally {
      queue.close();
    }
    const rest = await run(state.dir, false);
    expect({ err: rest.err, code: rest.code }).toEqual({ err: "", code: 0 });
    expect(rest.out).not.toContain("mode=gateway");
  } finally {
    state.done();
  }
});

for (const context of ["context", "context-denied"] as const)
  posix(`Gateway CLI preserves message/context groups and cursor commits with ${context}`, async () => {
    const state = withState();
    try {
      const { out, err, code } = await run(state.dir, true, context);
      expect({ err, code }).toEqual({ err: "", code: 0 });
      const where = JSON.stringify(
        context === "context"
          ? {
              channel: { id: "30", name: "dev", topic: "editable topic", purpose: null },
              thread: { id: "20", name: "task thread", purpose: null },
            }
          : { channel: { id: "20", purpose: null }, thread: null, error: "channel lookup failed (HTTP 403)" },
      );
      expect(
        out
          .split("\n")
          .filter((line) => line.startsWith("INBOUND discord ") || line.startsWith("INBOUND_CONTEXT discord ")),
      ).toEqual([
        'INBOUND discord 20 101 from=owner ref=- "first owner text"',
        `INBOUND_CONTEXT discord 20 101 ${where}`,
        'INBOUND discord 20 103 from=owner ref=- "live owner text"',
        `INBOUND_CONTEXT discord 20 103 ${where}`,
      ]);
      expect(fileDiscordInboundStore(state.dir, "20").load()).toBe("103");
      const queue = discordInboundQueue(state.dir);
      try {
        expect(queue.first()).toBeNull();
      } finally {
        queue.close();
      }
    } finally {
      state.done();
    }
  });

posix("REST mode refuses pending Gateway work before baselining any channel", async () => {
  const state = withState();
  try {
    const queue = discordInboundQueue(state.dir);
    queue.push("message", ownerMessage("101", { channel_id: "21" }));
    queue.close();
    const { out, err, code } = await run(state.dir, false);
    expect({ code, out }).toEqual({ code: 1, out: "" });
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(err).toContain("restart with --gateway before REST mode");
    expect(fileDiscordInboundStore(state.dir, "20").load()).toBeUndefined();
    expect(fileDiscordInboundStore(state.dir, "21").load()).toBeUndefined();
    const recovered = discordInboundQueue(state.dir);
    try {
      expect(JSON.parse(recovered.first()!.payload).id).toBe("101");
    } finally {
      recovered.close();
    }
  } finally {
    state.done();
  }
});

for (const gateway of [false, true])
  posix(
    `public ${gateway ? "Gateway" : "REST"} CLI reports queue corruption as one sanitized nonzero error`,
    async () => {
      const state = withState();
      try {
        const dir = join(state.dir, "discord-inbound");
        mkdirSync(dir, { mode: 0o700 });
        writeFileSync(join(dir, "gateway.sqlite"), "corrupt", { mode: 0o600 });
        const { out, err, code } = await run(state.dir, gateway);
        expect({ code, out }).toEqual({ code: 1, out: "" });
        expect(err.trim().split("\n")).toHaveLength(1);
        expect(err).toContain("queue storage failed");
        expect(err).not.toContain(state.dir);
      } finally {
        state.done();
      }
    },
  );
