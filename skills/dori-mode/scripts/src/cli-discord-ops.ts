/** Discord send/thread/react operations and URL audio staging for the existing transcription hook. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { type DcChannel, Discord, isForumType } from "./messenger/discord.ts";
import { discordInboundEnv } from "./messenger/discord-inbound-state.ts";
import { fetchHttp } from "./messenger/http.ts";
import { TranscriptionError } from "./messenger/voice.ts";
import { realClock } from "./run.ts";

const client = () =>
  new Discord(fetchHttp, realClock, process.env["DORI_DISCORD_TOKEN"] ?? die("DORI_DISCORD_TOKEN is not set"));

/** Local paths pass through; downloaded audio belongs only to this invocation and is always removed. */
export const withLocalAudio = async (source: string, use: (file: string) => Promise<string>): Promise<string> => {
  if (!/^https?:\/\//i.test(source)) return await use(source);
  const dir = mkdtempSync(join(tmpdir(), "dori-audio-"));
  try {
    let file: string;
    try {
      const url = new URL(source);
      const response = await fetch(url);
      if (!response.ok) throw new TranscriptionError(`transcribe: GET ${url.pathname} answered ${response.status}`);
      file = join(dir, basename(url.pathname) || "audio");
      writeFileSync(file, new Uint8Array(await response.arrayBuffer()), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError("transcribe: could not download audio");
    }
    return await use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

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

export const sendDiscord: Command = async ({ need, opt }) => {
  const thread = opt("thread");
  const to = thread === undefined ? need("to") : undefined;
  const text = need("text");
  const edit = opt("edit");
  const dc = client();
  let target: string;
  if (thread !== undefined) target = discordInboundEnv("--thread", thread);
  else {
    const channel = await channelOf(dc, to!);
    if (isForumType(channel.type))
      die(`${channel.id} is a forum: post with dori thread discord create, or pass --thread`);
    target = channel.id;
  }
  if (edit) await dc.edit(target, edit, text);
  else console.log(`SENT ${await dc.send(target, text)}`);
};

export const threadDiscord: Command = async ({ positionals, need, strings, values }) => {
  const action = positionals[1];
  const tags = strings("tag");
  if (values["archive"] === true && values["unarchive"] === true) die("choose --archive or --unarchive");
  const dc = client();
  if (action === "create") {
    const channel = await channelOf(dc, need("to"));
    if (tags.length && !isForumType(channel.type)) die("--tag needs a forum channel");
    const title = need("title");
    const name = values["title"];
    const text = values["text"];
    const thread = await dc.createThread(channel, typeof name === "string" ? name : title, {
      ...(typeof text === "string" ? { text } : {}),
      ...(tags.length ? { appliedTags: tagIds(channel, tags) } : {}),
    });
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
  } else die("thread discord needs create or set");
};

export const reactDiscord: Command = async ({ need, opt, values }) => {
  const thread = opt("thread");
  const channel = thread === undefined ? discordInboundEnv("--to", need("to")) : discordInboundEnv("--thread", thread);
  const message = discordInboundEnv("--message", need("message"));
  const remove = values["remove"] === true;
  await client().react(channel, message, opt("emoji") || "\u{1f440}", remove);
  console.log(`REACTED ${channel} ${remove ? "-" : "+"}`);
};
