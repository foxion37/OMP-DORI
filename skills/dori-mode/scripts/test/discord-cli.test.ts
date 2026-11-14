import { expect, test } from "bun:test";
import { ids, withDiscordCli } from "./discord-fakes.ts";

const guild = { environment: { DORI_DISCORD_GUILD_ID: ids.guild } };

test("Discord sends retain ID delivery and edit the selected thread, with optional guild name lookup", async () => {
  await withDiscordCli(async (f) => {
    for (const target of [ids.text, "chat", "#chat"]) {
      const r = await f.invoke(["send", "discord", "--to", target, "--text", "hi @everyone"], guild);
      expect([r.code, r.err, r.out, r.keys]).toEqual([
        0,
        "",
        `SENT ${ids.message}`,
        [
          target === ids.text ? `GET /channels/${ids.text}` : `GET /guilds/${ids.guild}/channels`,
          `POST /channels/${ids.text}/messages`,
        ],
      ]);
      expect(r.requests[1]!.body).toEqual({ content: "hi @everyone", allowed_mentions: { parse: [] } });
    }
    const thread = ["send", "discord", "--thread", ids.thread, "--text", "v2"];
    const sent = await f.invoke(thread);
    expect([sent.code, sent.out, sent.keys]).toEqual([
      0,
      `SENT ${ids.message}`,
      [`POST /channels/${ids.thread}/messages`],
    ]);
    for (const extra of [[], ["--to", ids.text]]) {
      const r = await f.invoke([...thread, "--edit", ids.message, ...extra]);
      expect([r.code, r.out, r.keys, r.requests[0]!.body]).toEqual([
        0,
        "",
        [`PATCH /channels/${ids.thread}/messages/${ids.message}`],
        { content: "v2" },
      ]);
    }
    const edited = await f.invoke(["send", "discord", "--to", ids.text, "--edit", ids.message, "--text", "old path"]);
    expect([edited.code, edited.out, edited.keys.at(-1)]).toEqual([
      0,
      "",
      `PATCH /channels/${ids.text}/messages/${ids.message}`,
    ]);
    for (const target of [ids.forum, ids.media, "#tasks"]) {
      const r = await f.invoke(["send", "discord", "--to", target, "--text", "x"], guild);
      expect(r.code).toBe(1);
      expect(r.err).toContain("is a forum: post with dori thread discord create, or pass --thread");
      expect(r.keys).toHaveLength(1);
    }
    const missing = await f.invoke(["send", "discord"]);
    expect([missing.code, missing.err, missing.keys]).toEqual([1, "--to is required", []]);
    const token = await f.invoke(["send", "discord", "--to", ids.text, "--text", "x"], {
      environment: { DORI_DISCORD_TOKEN: undefined },
    });
    expect([token.code, token.err, token.keys]).toEqual([1, "DORI_DISCORD_TOKEN is not set", []]);
    const noGuild = await f.invoke(["send", "discord", "--to", "chat", "--text", "x"]);
    expect([noGuild.code, noGuild.keys]).toEqual([1, []]);
    expect(noGuild.err).toContain("DORI_DISCORD_GUILD_ID");
    for (const channels of [
      [],
      [
        { id: "21", name: "chat" },
        { id: "22", name: "chat" },
      ],
    ]) {
      const r = await f.invoke(["send", "discord", "--to", "chat", "--text", "x"], {
        ...guild,
        routes: { [`GET /guilds/${ids.guild}/channels`]: { body: channels } },
      });
      expect([r.code, r.err, r.keys.length]).toEqual([
        1,
        `--to chat: ${channels.length} channels have that name in guild ${ids.guild}`,
        1,
      ]);
    }
    const denied = await f.invoke(["send", "discord", "--thread", ids.thread, "--text", "x"], {
      routes: { [`POST /channels/${ids.thread}/messages`]: { status: 403, body: { message: "Denied" } } },
    });
    expect([denied.code, denied.out, denied.err.split("\n").length]).toEqual([1, "", 1]);
    expect(denied.err).toContain(`discord POST /channels/${ids.thread}/messages: 403`);
  });
}, 60_000);

test("Discord creates text threads and tagged forum posts, then renames, retags, archives and reopens", async () => {
  await withDiscordCli(async (f) => {
    const title = "  task title  ";
    const text = "  starter @everyone\nsecond line  ";
    const base = ["thread", "discord", "create", "--title", title];
    const forum = await f.invoke(
      [...base, "--to", "#tasks", "--text", text, "--tag", "working", "--tag", ids.done],
      guild,
    );
    expect([forum.code, forum.out, forum.keys]).toEqual([
      0,
      `THREAD ${ids.thread} mid=${ids.starter}`,
      [`GET /guilds/${ids.guild}/channels`, `POST /channels/${ids.forum}/threads`],
    ]);
    expect(forum.requests[1]!.body).toEqual({
      name: title,
      message: { content: text, allowed_mentions: { parse: [] } },
      applied_tags: [ids.working, ids.done],
    });
    const fallback = await f.invoke([...base, "--to", ids.forum]);
    expect(fallback.requests[1]!.body).toEqual({
      name: title,
      message: { content: title, allowed_mentions: { parse: [] } },
    });
    const media = await f.invoke([...base, "--to", ids.media]);
    expect([media.code, media.out]).toEqual([0, `THREAD ${ids.thread}`]);
    for (const flags of [[], ["--text", text]]) {
      const r = await f.invoke([...base, "--to", ids.text, ...flags]);
      expect([r.code, r.out, r.keys]).toEqual([
        0,
        `THREAD ${ids.thread}${flags.length ? ` mid=${ids.message}` : ""}`,
        [
          `GET /channels/${ids.text}`,
          `POST /channels/${ids.text}/threads`,
          ...(flags.length ? [`POST /channels/${ids.thread}/messages`] : []),
        ],
      ]);
      expect(r.requests[1]!.body).toEqual({ name: title, type: 11 });
      if (flags.length) expect(r.requests[2]!.body).toEqual({ content: text, allowed_mentions: { parse: [] } });
    }
    const long = await f.invoke(["thread", "discord", "create", "--to", ids.text, "--title", "x".repeat(101)]);
    expect([long.code, long.requests[1]!.body]).toEqual([0, { name: "x".repeat(100), type: 11 }]);
    const set = ["thread", "discord", "set", ids.thread];
    const changed = await f.invoke([...set, "--title", title, "--tag", "done", "--archive"], {
      routes: { [`PATCH /channels/${ids.thread}`]: { body: { id: "41" } } },
    });
    expect([changed.code, changed.out, changed.keys]).toEqual([
      0,
      "THREAD 41",
      [`GET /channels/${ids.thread}`, `GET /channels/${ids.forum}`, `PATCH /channels/${ids.thread}`],
    ]);
    expect(changed.requests[2]!.body).toEqual({ name: title, applied_tags: [ids.done], archived: true });
    const reopened = await f.invoke([...set, "--unarchive"]);
    expect([reopened.code, reopened.out, reopened.keys, reopened.requests[0]!.body]).toEqual([
      0,
      `THREAD ${ids.thread}`,
      [`PATCH /channels/${ids.thread}`],
      { archived: false },
    ]);
    const invalid = [
      [...base, "--to", ids.forum, "--tag", "unknown"],
      [...set, "--tag", "unknown"],
      [...base, "--to", ids.text, "--tag", "done"],
      [...set],
      [...set, "--title", ""],
      [...set, "--archive", "--unarchive"],
      [...base, "--to", ids.text, "--text", "$(id)"],
      ["thread", "discord", "create", "--to", ids.forum],
    ];
    for (const args of invalid) {
      const r = await f.invoke(args);
      expect([r.code, r.out, r.keys.every((key) => key.startsWith("GET "))]).toEqual([1, "", true]);
      if (args.includes("unknown")) expect(r.err).toBe(`forum ${ids.forum} has no tag "unknown"; tags: working, done`);
    }
    const wrongParent = await f.invoke([...set, "--tag", "done"], {
      routes: { [`GET /channels/${ids.thread}`]: { body: { id: ids.thread, parent_id: ids.text } } },
    });
    expect([wrongParent.code, wrongParent.err, wrongParent.keys.length]).toEqual([1, "--tag needs a forum post", 2]);
  });
}, 60_000);

test("Discord reactions add and remove the bot's own encoded Unicode or custom emoji", async () => {
  await withDiscordCli(async (f) => {
    for (const remove of [false, true]) {
      const flags = remove ? ["--remove"] : [];
      for (const target of [
        ["--thread", ids.thread],
        ["--to", ids.forum, "--thread", ids.thread],
      ]) {
        const r = await f.invoke(["react", "discord", ...target, "--message", ids.message, ...flags]);
        expect([r.code, r.out, r.keys, r.requests[0]!.body]).toEqual([
          0,
          `REACTED ${ids.thread} ${remove ? "-" : "+"}`,
          [`${remove ? "DELETE" : "PUT"} /channels/${ids.thread}/messages/${ids.message}/reactions/%F0%9F%91%80/@me`],
          null,
        ]);
      }
      const custom = await f.invoke([
        "react",
        "discord",
        "--to",
        ids.text,
        "--message",
        ids.message,
        "--emoji",
        "party:123",
        ...flags,
      ]);
      expect([custom.code, custom.out, custom.keys]).toEqual([
        0,
        `REACTED ${ids.text} ${remove ? "-" : "+"}`,
        [`${remove ? "DELETE" : "PUT"} /channels/${ids.text}/messages/${ids.message}/reactions/party%3A123/@me`],
      ]);
    }
    for (const value of ["12ab", "0", "1e3", "18446744073709551616"]) {
      const r = await f.invoke(["react", "discord", "--to", ids.text, "--message", value]);
      expect([r.code, r.keys]).toEqual([1, []]);
      expect(r.err).toBe("--message must be a positive decimal Discord ID");
      const send = await f.invoke(["send", "discord", "--thread", value, "--text", "x"]);
      expect([send.code, send.keys, send.err]).toEqual([1, [], "--thread must be a positive decimal Discord ID"]);
    }
  });
}, 60_000);
