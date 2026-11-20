/** Discord send/thread/react operations. */
import { type Command, die, messageText } from "./cli-context.ts";
import { type DcChannel, Discord, isForumType } from "./messenger/discord.ts";
import { DiscordChannels, purposeText } from "./messenger/discord-channels.ts";
import { discordInboundEnv, isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";
import { renderDiscordTables } from "./messenger/discord-markdown.ts";
import { fetchHttp } from "./messenger/http.ts";
import { DISCORD_LIMIT } from "./messenger/split.ts";
import { recordMark, recordSent } from "./owes.ts";
import { realClock, runtimesOf } from "./run.ts";
import { setThreadStatus } from "./thread-status.ts";

const client = () =>
  new Discord(fetchHttp, realClock, process.env["DORI_DISCORD_TOKEN"] || die("DORI_DISCORD_TOKEN is not set"));

/** An exact channel ID, or a unique channel name in the explicitly selected guild. */
const channelOf = async (dc: Discord, raw: string): Promise<DcChannel> => {
  if (/^\d+$/.test(raw)) return await dc.channel(raw);
  const guild = discordInboundEnv(
    "DORI_DISCORD_GUILD_ID (to look up a channel by name)",
    process.env["DORI_DISCORD_GUILD_ID"],
  );
  const name = raw.replace(/^#/, "");
  const hits = (await dc.guildChannels(guild)).filter((channel) => channel.name === name);
  if (hits.length !== 1) die(`--to ${raw}: ${hits.length} channels have that name in guild ${guild}`);
  return hits[0]!;
};

/** Tags replace the complete applied set; unknown names include the forum's known tag names in the error. */
const tagIds = (forum: DcChannel, names: readonly string[]): string[] =>
  names.map((name) => {
    const tags = forum.available_tags ?? [];
    return (
      tags.find((tag) => tag.name === name || tag.id === name)?.id ??
      die(
        `forum ${forum.id} has no tag ${JSON.stringify(name)}; tags: ${tags.map((tag) => tag.name).join(", ") || "none"}`,
      )
    );
  });

export const sendDiscord: Command = async (cli) => {
  const { need, opt, values, config } = cli;
  const thread = opt("thread");
  const to = thread === undefined ? need("to") : undefined;
  const rawText = await messageText(cli);
  const text = values["render-tables"] === true ? renderDiscordTables(rawText, 64 * 1024) : rawText;
  // An --edit given empty ("$UNSET") or not a message id is refused before any request: it must never post anew.
  const edit = values["edit"] === undefined ? undefined : discordInboundEnv("--edit", opt("edit"));
  // Likewise a --reply that is not a message id never becomes a plain post.
  const reply = values["reply"] === undefined ? undefined : discordInboundEnv("--reply", opt("reply"));
  if (edit !== undefined && reply !== undefined) die("--reply makes a new message; it cannot be used with --edit");
  // An edit replaces one message, so it is never split: over the limit it is refused before the channel lookup.
  if (edit !== undefined && text.length > DISCORD_LIMIT)
    die(`--edit text exceeds ${DISCORD_LIMIT} UTF-16 code units; shorten the text or send without --edit`);
  const dc = client();
  let target: string;
  if (thread !== undefined) target = discordInboundEnv("--thread", thread);
  else {
    const channel = await channelOf(dc, to!);
    if (isForumType(channel.type))
      die(`${channel.id} is a forum: post with dori thread discord create, or pass --thread`);
    target = channel.id;
  }
  if (edit !== undefined) await dc.edit(target, edit, text);
  else {
    const { ids, replyConfirmed } = await dc.sendDelivery(target, text, reply === undefined ? {} : { replyTo: reply });
    if (reply !== undefined) {
      const known = ids.filter(isDiscordSnowflake);
      if (known.length !== ids.length) {
        const posted = known.length ? ` (already posted: ${known.join(" ")})` : "";
        die(`discord send: incomplete delivery receipt; outcome uncertain${posted}`);
      }
      // An accepted plain fallback sends the answer, but it does not settle the exact owner request.
      if (replyConfirmed) await recordSent(config.stateDir, target, reply, ids, Date.now());
    }
    console.log(`SENT ${ids.join(" ")}`);
  }
};

export const threadDiscord: Command = async ({ positionals, need, opt, strings, values, deps }) => {
  const action = positionals[1];
  const tags = strings("tag");
  if (values["archive"] === true && values["unarchive"] === true) die("choose --archive or --unarchive");
  if (action === "status") {
    if (positionals.length !== 4 || ["title", "tag", "archive", "unarchive"].some((flag) => values[flag] !== undefined))
      die("thread status takes only <thread> done|working; use thread set for title, tags or archive changes");
    const id = discordInboundEnv("thread", positionals[2]);
    const status = positionals[3];
    if (status !== "done" && status !== "working") return die("thread status needs done or working");
    const caller = await deps.registry.bySession(runtimesOf(deps).selfAny(process.env));
    if (caller) die(`thread status is the lead's; this pane is lane ${caller.key}`);
    const open = (await deps.registry.open()).filter((lane) => lane.thread === `discord:${id}` || lane.thread === id);
    if (status === "done" && open.length)
      die(`thread still has open lanes: ${open.map((lane) => lane.key).join(", ")}`);
    const result = await setThreadStatus(client(), id, status);
    console.log(
      `THREAD_STATUS ${id} ${status} ${result.changed ? "changed" : "unchanged"} ${JSON.stringify(result.name)}`,
    );
    return;
  }
  const dc = client();
  if (action === "create") {
    // A thread on an existing message: checked before any request, so a bad id never opens a thread without one.
    const message = values["message"] === undefined ? undefined : discordInboundEnv("--message", opt("message"));
    // Any --tag counts, a bare one included: it is never silently dropped from a --message thread.
    if (message !== undefined && values["tag"] !== undefined)
      die("--tag needs a forum post; --message opens a thread on a message");
    const channel = await channelOf(dc, need("to"));
    if (tags.length && !isForumType(channel.type)) die("--tag needs a forum channel");
    if (message !== undefined && isForumType(channel.type))
      die(`${channel.id} is a forum: its posts are threads already; drop --message`);
    const title = need("title");
    const name = values["title"];
    const text = values["text"];
    const titled = typeof name === "string" ? name : title;
    const thread =
      message === undefined
        ? await dc.createThread(channel, titled, {
            ...(typeof text === "string" ? { text } : {}),
            ...(tags.length ? { appliedTags: tagIds(channel, tags) } : {}),
          })
        : await dc.threadOnMessage(channel.id, message, titled, typeof text === "string" ? text : undefined);
    console.log(`THREAD ${thread.id}${thread.messageId === undefined ? "" : ` mid=${thread.messageId}`}`);
  } else if (action === "set") {
    const threadId = discordInboundEnv("thread", positionals[2]);
    const title = values["title"] === undefined ? undefined : need("title");
    const name = values["title"];
    let appliedTags: string[] | undefined;
    if (tags.length) {
      const parent = (await dc.channel(threadId)).parent_id ?? die(`${threadId} is not a thread`);
      const forum = await dc.channel(parent);
      if (!isForumType(forum.type)) die("--tag needs a forum post");
      appliedTags = tagIds(forum, tags);
    }
    const archived = values["archive"] === true ? true : values["unarchive"] === true ? false : undefined;
    if (title === undefined && appliedTags === undefined && archived === undefined)
      die("thread set needs --title, --tag, --archive or --unarchive");
    const id = await dc.setThread(threadId, {
      ...(title === undefined ? {} : { name: typeof name === "string" ? name : title }),
      ...(appliedTags === undefined ? {} : { appliedTags }),
      ...(archived === undefined ? {} : { archived }),
    });
    console.log(`THREAD ${id}`);
  } else die("thread discord needs create, set or status");
};

/** The operator's purpose notes per channel or thread: `set <channel> --purpose T`, `clear <channel>`, `list`. */
export const channelDiscord: Command = async ({ positionals, opt, config }) => {
  const action = positionals[1];
  const store = new DiscordChannels(config.stateDir);
  if (action === "list") {
    for (const [id, entry] of Object.entries(store.read()))
      console.log(
        `CHANNEL ${id} name=${JSON.stringify(entry.name ?? "")} purpose=${JSON.stringify(entry.purpose)} updated=${entry.updatedAt}`,
      );
    return;
  }
  if (action !== "set" && action !== "clear") return die("channel discord needs set, clear or list");
  const raw = positionals[2] ?? die(`channel discord ${action} needs a channel or thread`);
  if (action === "clear") {
    // An ID needs no lookup, so a deleted channel's note can still be removed.
    const id = /^\d+$/.test(raw) ? discordInboundEnv("channel", raw) : (await channelOf(client(), raw)).id;
    console.log(`${(await store.clear(id)) ? "PURPOSE_CLEARED" : "PURPOSE_NONE"} ${id}`);
    return;
  }
  // Checked before the lookup, so a bad purpose sends no request.
  const purpose = purposeText(opt("purpose") ?? "");
  const channel = await channelOf(client(), raw);
  // A DM or an unnamed channel may answer with a null name: only a string is recorded.
  const name = typeof channel.name === "string" ? channel.name : undefined;
  const entry = await store.set(channel.id, purpose, name, Date.now());
  console.log(`PURPOSE ${channel.id} ${JSON.stringify(entry.purpose)}`);
};

export const reactDiscord: Command = async ({ need, opt, values, config }) => {
  const thread = opt("thread");
  const channel = thread === undefined ? discordInboundEnv("--to", need("to")) : discordInboundEnv("--thread", thread);
  const message = discordInboundEnv("--message", need("message"));
  const remove = values["remove"] === true;
  await client().react(channel, message, opt("emoji") || "\u{1f440}", remove);
  // A read receipt on the owner's exact message is half of the answer; the gate reads this to settle the owe.
  if (!remove) await recordMark(config.stateDir, channel, message, Date.now());
  console.log(`REACTED ${channel} ${remove ? "-" : "+"}`);
};
