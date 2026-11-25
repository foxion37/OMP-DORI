import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelPurposeError, DiscordChannels } from "../src/messenger/discord-channels.ts";
import { withState } from "./fakes.ts";

const source = { botId: "70", ownerId: "7", channelId: "40", messageId: "50" } as const;
const key = JSON.stringify(["70", "7", "40", "50", "30"]);

test("purpose notes and their source receipt are written to one private file", async () => {
  const state = withState();
  try {
    const store = new DiscordChannels(state.dir);
    const note = await store.set("20", "old note", "chat", Date.parse("2026-11-19T00:00:00Z"));
    const entry = await store.set("30", "  goal  ", "tasks", 0, source);
    expect(store.read()).toEqual({ "20": note, "30": entry });
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({
      version: 1,
      notes: { "20": note, "30": entry },
      receipts: { [key]: { source, channel: "30", purpose: "goal", result: entry } },
    });
    if (process.platform !== "win32") expect(statSync(store.path).mode & 0o777).toBe(0o600);
  } finally {
    state.done();
  }
});

test("a restarted writer replays the saved set result rather than overwriting later manual state", async () => {
  const state = withState();
  try {
    const store = new DiscordChannels(state.dir);
    const original = await store.set("30", "original", "old name", 0, source);
    const current = await store.set("30", "manual", "new name", 1000);
    const bytes = readFileSync(store.path, "utf8");
    const modified = statSync(store.path, { bigint: true }).mtimeNs;
    const restarted = new DiscordChannels(state.dir);
    expect(await restarted.set("30", " original ", "renamed", 2000, source)).toEqual(original);
    expect(restarted.read()["30"]).toEqual(current);
    expect(readFileSync(store.path, "utf8")).toBe(bytes);
    expect(statSync(store.path, { bigint: true }).mtimeNs).toBe(modified);
    await expect(restarted.set("30", "different", undefined, 3000, source)).rejects.toThrow("source identity conflict");
    await expect(restarted.clear("30", source)).rejects.toThrow("source identity conflict");
    expect(readFileSync(store.path, "utf8")).toBe(bytes);
  } finally {
    state.done();
  }
});

for (const existed of [false, true])
  test(`a ${existed ? "present" : "missing"} purpose keeps its original clear receipt across later edits`, async () => {
    const state = withState();
    try {
      const store = new DiscordChannels(state.dir);
      if (existed) await store.set("30", "before", undefined, 0);
      expect(await store.clear("30", source)).toBe(existed);
      const current = await store.set("30", "after", undefined, 1000);
      const bytes = readFileSync(store.path, "utf8");
      const restarted = new DiscordChannels(state.dir);
      expect(await restarted.clear("30", source)).toBe(existed);
      expect(restarted.read()["30"]).toEqual(current);
      expect(readFileSync(store.path, "utf8")).toBe(bytes);
    } finally {
      state.done();
    }
  });

test("independent processes cannot commit conflicting purposes for the same source and destination", async () => {
  const state = withState();
  try {
    const script = `const { DiscordChannels } = await import(process.env.STORE_MODULE);
try {
  const result = await new DiscordChannels(process.env.STATE_DIR).set(
    "30", process.env.PURPOSE_TEXT, undefined, 0,
    { botId: "70", ownerId: "7", channelId: "40", messageId: "50" },
  );
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const children = ["alpha", "beta"].map((purpose) =>
      Bun.spawn([process.execPath, "-e", script], {
        env: {
          HOME: state.dir,
          STORE_MODULE: join(import.meta.dir, "../src/messenger/discord-channels.ts"),
          STATE_DIR: state.dir,
          PURPOSE_TEXT: purpose,
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, out, err };
      }),
    );
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const winner = results.find((result) => result.code === 0)!;
    const conflict = results.find((result) => result.code === 1)!;
    expect(conflict.err).toContain("source identity conflict");
    expect(new DiscordChannels(state.dir).read()["30"]).toEqual(JSON.parse(winner.out));
  } finally {
    state.done();
  }
});

test("damaged source receipts are never silently discarded or overwritten", async () => {
  const state = withState();
  try {
    const store = new DiscordChannels(state.dir);
    const entry = await store.set("30", "goal", undefined, 0, source);
    const receipt = { source, channel: "30", purpose: "goal", result: entry };
    const good = { version: 1, notes: { "30": entry }, receipts: { [key]: receipt } };
    for (const damaged of [
      { "30": entry },
      { ...good, version: 2 },
      { ...good, extra: true },
      { ...good, notes: [] },
      { ...good, receipts: [] },
      { ...good, receipts: { wrong: receipt } },
      { ...good, receipts: { [key]: { ...receipt, source: { ...source, messageId: "51" } } } },
      { ...good, receipts: { [key]: { ...receipt, result: false } } },
      { ...good, receipts: { [key]: { ...receipt, purpose: "tampered" } } },
    ]) {
      const bytes = JSON.stringify(damaged);
      writeFileSync(store.path, bytes);
      expect(() => store.read()).toThrow(ChannelPurposeError);
      await expect(store.set("30", "goal", undefined, 1000, source)).rejects.toBeInstanceOf(ChannelPurposeError);
      expect(readFileSync(store.path, "utf8")).toBe(bytes);
    }
  } finally {
    state.done();
  }
});
