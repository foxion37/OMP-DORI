import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { type DcChannel, Discord } from "../src/messenger/discord.ts";
import { ChannelPurposeError, DiscordChannels, inboundContext } from "../src/messenger/discord-channels.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { ids, withDiscordCli } from "./discord-fakes.ts";
import { fakeClock, withState } from "./fakes.ts";

/** A Discord whose channel lookups answer from a table, counting each lookup. */
const fakeDiscord = (table: Record<string, DcChannel | MessengerError | "hang">) => {
  const looked: string[] = [];
  const discord = new Discord(async () => ({ status: 500, headers: {}, body: "" }), fakeClock(0), "t");
  discord.channel = async (id: string) => {
    looked.push(id);
    const answer = table[id];
    if (answer === "hang") return await new Promise<DcChannel>(() => {});
    if (answer instanceof MessengerError) throw answer;
    if (answer === undefined) throw new MessengerError("missing", 404);
    return answer;
  };
  return { discord, looked };
};

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
      const damaged = JSON.stringify({ "20": { purpose, updatedAt: "2026-11-17T00:00:00.000Z" } });
      writeFileSync(store.path, damaged);
      expect(() => store.read()).toThrow(ChannelPurposeError);
      await expect(store.set("30", "fine", undefined, 0)).rejects.toBeInstanceOf(ChannelPurposeError);
      expect(readFileSync(store.path, "utf8")).toBe(damaged);
    }
  } finally {
    state.done();
  }
});

test("context names a thread under its parent, marks a DM, caches lookups and never throws", async () => {
  const state = withState();
  try {
    const store = new DiscordChannels(state.dir);
    await store.set("30", "dev", "dev", 0);
    await store.set("50", "owner DM", undefined, 0);
    const { discord, looked } = fakeDiscord({
      "20": { id: "20", type: 11, name: "task", parent_id: "30" },
      "30": { id: "30", type: 0, name: "dev", topic: "" },
      "50": { id: "50", type: 1 },
      "60": "hang",
      "70": { id: "70", type: 11, name: "orphan", parent_id: "71" },
    });
    let now = 0;
    const where = inboundContext(discord, store, () => now, 20);
    expect(await where("20")).toEqual({
      channel: { id: "30", name: "dev", purpose: "dev" },
      thread: { id: "20", name: "task", purpose: null },
    });
    expect(await where("50")).toEqual({ channel: { id: "50", dm: true, purpose: "owner DM" }, thread: null });
    expect(await where("60")).toEqual({
      channel: { id: "60", purpose: null },
      thread: null,
      error: "channel lookup timed out",
    });
    // A thread whose parent cannot be read is still a thread under that parent ID.
    expect(await where("70")).toEqual({
      channel: { id: "71", purpose: null },
      thread: { id: "70", name: "orphan", purpose: null },
      error: "channel lookup failed (HTTP 404)",
    });
    // A failed or hung lookup is remembered for the minute: no second request, and no second wait once past the bound.
    now = 30;
    expect((await where("70")).error).toBe("channel lookup failed (HTTP 404)");
    expect((await where("60")).error).toBe("channel lookup timed out");
    expect(looked.filter((id) => id === "71" || id === "60")).toEqual(["60", "71"]);
    now = 0;
    expect(looked.filter((id) => id === "20" || id === "30")).toEqual(["20", "30"]);
    await where("20");
    expect(looked.filter((id) => id === "20")).toHaveLength(1);
    now = 60_000;
    await where("20");
    expect(looked.filter((id) => id === "20")).toHaveLength(2);
    writeFileSync(store.path, "[]");
    expect(await where("20")).toEqual({
      channel: { id: "30", name: "dev", purpose: null },
      thread: { id: "20", name: "task", purpose: null },
      error: "channel purposes unreadable",
    });
  } finally {
    state.done();
  }
});

test("a long-running context drops expired lookups and never holds more than 500", async () => {
  const state = withState();
  try {
    const table: Record<string, DcChannel> = {};
    for (let i = 1; i <= 700; i++) table[String(1000 + i)] = { id: String(1000 + i), type: 0, name: `c${i}` };
    const { discord, looked } = fakeDiscord(table);
    let now = 0;
    const where = inboundContext(discord, new DiscordChannels(state.dir), () => now, 20);
    for (let i = 1; i <= 100; i++) await where(String(1000 + i));
    expect(where.cached()).toBe(100);
    // Channels seen once are not kept past their minute, even if never looked up again.
    now = 60_000;
    await where("1101");
    expect(where.cached()).toBe(1);
    // A burst across more channels than the cap keeps the newest 500 and still answers each one.
    for (let i = 102; i <= 700; i++) await where(String(1000 + i));
    expect(where.cached()).toBe(500);
    expect((await where("1700")).channel.name).toBe("c700");
    expect(looked.filter((id) => id === "1700")).toHaveLength(1);
  } finally {
    state.done();
  }
});

test("dori channel discord sets a looked-up channel's purpose, lists and clears it; bad input sends nothing", async () => {
  await withDiscordCli(async (f) => {
    const set = await f.invoke(["channel", "discord", "set", ids.text, "--purpose", "omp-dori development"]);
    expect([set.code, set.err, set.out, set.keys]).toEqual([
      0,
      "",
      `PURPOSE ${ids.text} "omp-dori development"`,
      [`GET /channels/${ids.text}`],
    ]);
    const byName = await f.invoke(["channel", "discord", "set", "#tasks", "--purpose", "task posts"], {
      environment: { DORI_DISCORD_GUILD_ID: ids.guild },
    });
    expect([byName.code, byName.out]).toEqual([0, `PURPOSE ${ids.forum} "task posts"`]);
    const listed = await f.invoke(["channel", "discord", "list"]);
    expect(listed.keys).toEqual([]);
    expect(listed.out.split("\n").map((line) => line.replace(/ updated=\S+$/, ""))).toEqual([
      `CHANNEL ${ids.text} name="chat" purpose="omp-dori development"`,
      `CHANNEL ${ids.forum} name="tasks" purpose="task posts"`,
    ]);
    const cleared = await f.invoke(["channel", "discord", "clear", ids.text], {
      environment: { DORI_DISCORD_TOKEN: undefined },
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
      expect([r.code, r.err, r.keys]).toEqual([1, err, []]);
    }
  });
}, 60_000);
