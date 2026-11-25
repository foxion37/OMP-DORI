import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { ChannelPurposeError, DiscordChannels } from "../src/messenger/discord-channels.ts";
import { ids, withDiscordCli } from "./discord-fakes.ts";
import { refusedOnWindows, withState } from "./fakes.ts";

test("purposes are stored privately, replaced, cleared and validated before anything is written", async () => {
  const state = withState();
  try {
    const store = new DiscordChannels(state.dir);
    expect(store.read()).toEqual({});
    await store.set("20", "  dev work  ", "chat", Date.parse("2026-11-17T00:00:00Z"));
    await store.set("40", "one task", undefined, Date.parse("2026-11-17T00:00:01Z"));
    await store.set("20", "dev and ops", "chat", Date.parse("2026-11-17T00:00:02Z"));
    expect(store.read()).toEqual({
      "20": { purpose: "dev and ops", name: "chat", updatedAt: "2026-11-17T00:00:02.000Z" },
      "40": { purpose: "one task", updatedAt: "2026-11-17T00:00:01.000Z" },
    });
    // Windows reports 0666 for any writable file; the 0600 check is POSIX-only.
    if (process.platform !== "win32") expect(statSync(store.path).mode & 0o777).toBe(0o600);
    for (const bad of ["", "   ", "two\nlines", "tab\there", "x".repeat(501), "sep\u2028arator", "flip\u202eped"])
      await expect(store.set("20", bad, undefined, 0)).rejects.toBeInstanceOf(ChannelPurposeError);
    await expect(store.set("chat", "fine", undefined, 0)).rejects.toBeInstanceOf(ChannelPurposeError);
    expect(await store.clear("40")).toBe(true);
    expect(await store.clear("40")).toBe(false);
    expect(Object.keys(store.read())).toEqual(["20"]);
    // A damaged file is reported, never silently replaced by a write.
    writeFileSync(store.path, "{not json");
    expect(() => store.read()).toThrow(ChannelPurposeError);
    await expect(store.set("20", "again", undefined, 0)).rejects.toBeInstanceOf(ChannelPurposeError);
    expect(readFileSync(store.path, "utf8")).toBe("{not json");
    // A hand-edited purpose that set would refuse is damage too, not a record to rewrite.
    for (const purpose of ["", " padded ", "two\nlines", "x".repeat(501)]) {
      const notes = { "20": { purpose, updatedAt: "2026-11-17T00:00:00.000Z" } };
      const damaged = JSON.stringify({ version: 1, notes, receipts: {} });
      writeFileSync(store.path, damaged);
      expect(() => store.read()).toThrow(ChannelPurposeError);
      await expect(store.set("30", "fine", undefined, 0)).rejects.toBeInstanceOf(ChannelPurposeError);
      expect(readFileSync(store.path, "utf8")).toBe(damaged);
    }
  } finally {
    state.done();
  }
});

test("cataly channel discord sets a looked-up channel's purpose, lists and clears it; bad input sends nothing", async () => {
  await withDiscordCli(async (f) => {
    const set = await f.invoke(["channel", "discord", "set", ids.text, "--purpose", "omp-cataly development"]);
    expect([set.code, set.err, set.out, set.keys]).toEqual([
      0,
      "",
      `PURPOSE ${ids.text} "omp-cataly development"`,
      [`GET /channels/${ids.text}`],
    ]);
    const byName = await f.invoke(["channel", "discord", "set", "#tasks", "--purpose", "task posts"], {
      environment: { CATALY_DISCORD_GUILD_ID: ids.guild },
    });
    expect([byName.code, byName.out]).toEqual([0, `PURPOSE ${ids.forum} "task posts"`]);
    const listed = await f.invoke(["channel", "discord", "list"]);
    expect(listed.keys).toEqual([]);
    expect(listed.out.split("\n").map((line) => line.replace(/ updated=\S+$/, ""))).toEqual([
      `CHANNEL ${ids.text} name="chat" purpose="omp-cataly development"`,
      `CHANNEL ${ids.forum} name="tasks" purpose="task posts"`,
    ]);
    const cleared = await f.invoke(["channel", "discord", "clear", ids.text], {
      environment: { CATALY_DISCORD_TOKEN: undefined },
    });
    expect([cleared.code, cleared.out, cleared.keys]).toEqual([0, `PURPOSE_CLEARED ${ids.text}`, []]);
    expect((await f.invoke(["channel", "discord", "clear", ids.text])).out).toBe(`PURPOSE_NONE ${ids.text}`);
    for (const [args, err] of [
      [["channel", "discord", "set", ids.text], "--purpose must be one line of 1 to 500 characters"],
      [
        ["channel", "discord", "set", ids.text, "--purpose", "a\nb"],
        "--purpose must be one line of 1 to 500 characters",
      ],
      [["channel", "discord", "set", "--purpose", "x"], "channel discord set needs a channel or thread"],
      [["channel", "discord", "drop", ids.text], "channel discord needs set, clear or list"],
      [["channel", "slack", "list"], "channel supports discord"],
      [["inbound", "telegram", "--context"], "--context is supported for discord only"],
    ] as const) {
      const r = await f.invoke([...args]);
      expect([r.code, r.err, r.keys]).toEqual([1, refusedOnWindows(args, err), []]);
    }
  });
}, 60_000);
