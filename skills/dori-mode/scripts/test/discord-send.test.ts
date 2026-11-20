import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ids, withDiscordCli } from "./discord-fakes.ts";

const posts = (...answers: string[]) => ({
  [`POST /channels/${ids.thread}/messages`]: { sequence: answers.map((id) => ({ body: { id } })) },
});
/** A recorded message body's content, or "" when the request carried none. */
const content = (body: unknown): string =>
  body !== null && typeof body === "object" && "content" in body && typeof body.content === "string"
    ? body.content
    : "";
const report = Array.from({ length: 90 }, (_, i) => `finding ${i}: the checked path and its evidence line`).join("\n");

test("a long Discord send is split, replies only with its first part, and prints every message id", async () => {
  await withDiscordCli(async (f) => {
    const file = join(f.tmp, "report.md");
    writeFileSync(file, `\n${report}\n`);
    const r = await f.invoke(["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text-file", file], {
      routes: posts("71", "72", "73"),
    });
    expect([r.code, r.err, r.out]).toEqual([0, "", "SENT 71 72 73"]);
    expect(r.keys).toEqual(Array(3).fill(`POST /channels/${ids.thread}/messages`));
    expect(r.requests.map((q) => q.body?.["message_reference"])).toEqual([
      { message_id: ids.message, channel_id: ids.thread, fail_if_not_exists: true },
      undefined,
      undefined,
    ]);
    for (const q of r.requests) expect(q.body?.["allowed_mentions"]).toEqual({ parse: [] });
    const parts = r.requests.map((q) => content(q.body));
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(2000);
    expect(parts.join("")).toBe(report);

    const piped = await f.invoke(["send", "discord", "--thread", ids.thread, "--text-file", "-"], {
      stdin: "from a pipe\n",
    });
    expect([piped.code, piped.out, piped.requests[0]?.body?.["content"]]).toEqual([
      0,
      `SENT ${ids.message}`,
      "from a pipe",
    ]);
    const short = await f.invoke(["send", "discord", "--thread", ids.thread, "--text", "hi", "--reply", ids.message]);
    expect([short.code, short.out, short.requests[0]?.body]).toEqual([
      0,
      `SENT ${ids.message}`,
      {
        content: "hi",
        allowed_mentions: { parse: [] },
        message_reference: { message_id: ids.message, channel_id: ids.thread, fail_if_not_exists: true },
      },
    ]);
  });
}, 60_000);

test("a rejected original reply stops the public CLI without posting an unlinked part", async () => {
  await withDiscordCli(async (f) => {
    const r = await f.invoke(["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text-file", "-"], {
      stdin: report,
      routes: {
        [`POST /channels/${ids.thread}/messages`]: { status: 400, body: { code: 10008, message: "Unknown Message" } },
      },
    });
    expect([r.code, r.out, r.keys]).toEqual([1, "", [`POST /channels/${ids.thread}/messages`]]);
    expect(r.err).toContain(`discord POST /channels/${ids.thread}/messages: 400`);
    expect(r.requests[0]?.body?.["message_reference"]).toEqual({
      message_id: ids.message,
      channel_id: ids.thread,
      fail_if_not_exists: true,
    });
  });
});

test("a part that fails stops the rest and names the parts already posted", async () => {
  await withDiscordCli(async (f) => {
    const r = await f.invoke(["send", "discord", "--thread", ids.thread, "--text-file", "-"], {
      stdin: report,
      routes: {
        [`POST /channels/${ids.thread}/messages`]: {
          sequence: [{ body: { id: "71" } }, { status: 403, body: { message: "Denied" } }],
        },
      },
    });
    expect([r.code, r.out, r.keys.length]).toEqual([1, "", 2]);
    expect(r.err).toContain(`discord POST /channels/${ids.thread}/messages: 403`);
    expect(r.err).toEndWith("(part 2 of 3; already posted: 71)");
    // A transport failure after a posted part names the posted parts too, in one line.
    const lost = await f.invoke(["send", "discord", "--thread", ids.thread, "--text-file", "-"], {
      stdin: report,
      routes: {
        [`POST /channels/${ids.thread}/messages`]: { sequence: [{ body: { id: "71" } }, { failure: "fetch" }] },
      },
    });
    expect([lost.code, lost.out, lost.err]).toEqual([
      1,
      "",
      `discord POST /channels/${ids.thread}/messages: delivery uncertain; the request may have succeeded; do not resend. Inspect the original remote target and reconcile its IDs before retrying. (part 2 of 3; already posted: 71)`,
    ]);
  });
}, 60_000);

test("bad reply, text-file and edit input is refused before any request", async () => {
  await withDiscordCli(async (f) => {
    const empty = join(f.tmp, "empty.md");
    const unsafe = join(f.tmp, "unsafe.md");
    writeFileSync(empty, " \n\n");
    writeFileSync(unsafe, "run $(id) later");
    const thread = ["send", "discord", "--thread", ids.thread];
    const cases: [string[], string][] = [
      [[...thread, "--text", "x", "--reply", ""], "--reply must be a positive decimal Discord ID"],
      [[...thread, "--text", "x", "--reply", "last"], "--reply must be a positive decimal Discord ID"],
      [
        [...thread, "--text", "x", "--reply", ids.message, "--edit", ids.message],
        "--reply makes a new message; it cannot be used with --edit",
      ],
      [[...thread, "--text", "x", "--text-file", empty], "choose --text or --text-file, not both"],
      [[...thread, "--text-file", join(f.tmp, "missing.md")], `--text-file ${join(f.tmp, "missing.md")}: ENOENT`],
      [[...thread, "--text-file", empty], `--text-file ${empty} is empty`],
      [[...thread, "--text-file", f.tmp], `--text-file ${f.tmp}: EISDIR`],
      [
        ["send", "discord", "--to", ids.text, "--edit", ids.message, "--text", "e".repeat(2001)],
        "--edit text exceeds 2000 UTF-16 code units; shorten the text or send without --edit",
      ],
      [["send", "telegram", "--to", "-1001", "--text", "x", "--reply", "7"], "--reply is supported for discord only"],
    ];
    for (const [args, err] of cases) {
      const r = await f.invoke(args);
      expect({ args, code: r.code, err: r.err, keys: r.keys }).toEqual({ args, code: 1, err, keys: [] });
    }
    const guarded = await f.invoke([...thread, "--text-file", unsafe]);
    expect([guarded.code, guarded.keys]).toEqual([1, []]);
    expect(guarded.err).toContain("$(");
    const edited = await f.invoke([...thread, "--edit", ids.message, "--text", "e".repeat(2000)]);
    expect([edited.code, edited.keys]).toEqual([0, [`PATCH /channels/${ids.thread}/messages/${ids.message}`]]);
  });
}, 60_000);

test("thread discord create --message opens a thread on that message, then sends optional text inside", async () => {
  await withDiscordCli(async (f) => {
    const routes = { [`POST /channels/${ids.text}/messages/${ids.message}/threads`]: { body: { id: ids.thread } } };
    const base = ["thread", "discord", "create", "--to", ids.text, "--title", "[dev] task", "--message", ids.message];
    const bare = await f.invoke(base, { routes });
    expect([bare.code, bare.out, bare.keys]).toEqual([
      0,
      `THREAD ${ids.thread}`,
      [`GET /channels/${ids.text}`, `POST /channels/${ids.text}/messages/${ids.message}/threads`],
    ]);
    expect(bare.requests[1]?.body).toEqual({ name: "[dev] task" });
    const texted = await f.invoke([...base, "--text", report], { routes: { ...routes, ...posts("71", "72", "73") } });
    expect([texted.code, texted.out, texted.keys.slice(2)]).toEqual([
      0,
      `THREAD ${ids.thread} mid=71`,
      Array(3).fill(`POST /channels/${ids.thread}/messages`),
    ]);
    const forum = await f.invoke(["thread", "discord", "create", "--to", ids.forum, "--title", "t", "--message", "5"]);
    expect([forum.code, forum.err, forum.keys]).toEqual([
      1,
      `${ids.forum} is a forum: its posts are threads already; drop --message`,
      [`GET /channels/${ids.forum}`],
    ]);
    for (const [extra, err] of [
      [["--message", "last"], "--message must be a positive decimal Discord ID"],
      [["--message", ids.message, "--tag", "done"], "--tag needs a forum post; --message opens a thread on a message"],
      [["--message", ids.message, "--tag"], "--tag needs a forum post; --message opens a thread on a message"],
    ] as const) {
      const r = await f.invoke(["thread", "discord", "create", "--to", ids.text, "--title", "t", ...extra]);
      expect([r.code, r.err, r.keys]).toEqual([1, err, []]);
    }
  });
}, 60_000);

test("long thread starter text continues as messages in the new thread or forum post", async () => {
  await withDiscordCli(async (f) => {
    const forum = await f.invoke(["thread", "discord", "create", "--to", ids.forum, "--title", "t", "--text", report], {
      routes: posts("72", "73"),
    });
    expect([forum.code, forum.out, forum.keys]).toEqual([
      0,
      `THREAD ${ids.thread} mid=${ids.starter}`,
      [
        `GET /channels/${ids.forum}`,
        `POST /channels/${ids.forum}/threads`,
        ...Array(2).fill(`POST /channels/${ids.thread}/messages`),
      ],
    ]);
    const starter = content(forum.requests[1]?.body?.["message"]);
    const rest = forum.requests.slice(2).map((q) => content(q.body));
    expect(starter.length).toBeLessThanOrEqual(2000);
    expect([starter, ...rest].join("")).toBe(report);
    const failed = await f.invoke(
      ["thread", "discord", "create", "--to", ids.forum, "--title", "t", "--text", report],
      {
        routes: {
          [`POST /channels/${ids.thread}/messages`]: {
            sequence: [{ body: { id: "72" } }, { status: 403, body: { message: "Denied" } }],
          },
        },
      },
    );
    expect(failed.code).toBe(1);
    expect(failed.err).toEndWith(`(part 3 of 3; already posted: ${ids.starter} 72)`);
  });
}, 60_000);
