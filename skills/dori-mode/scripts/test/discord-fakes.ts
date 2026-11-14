import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

export const ids = {
  guild: "10",
  text: "20",
  forum: "30",
  media: "31",
  thread: "40",
  message: "50",
  starter: "51",
  working: "60",
  done: "61",
} as const;

export type DiscordRoute = {
  readonly body?: unknown;
  readonly raw?: string;
  readonly status?: number;
  readonly failure?: "fetch" | "body";
};
type RecordedRequest = { readonly key: string; readonly body: Record<string, unknown> | null };
type AudioReceipt = {
  readonly file: string;
  readonly content: string;
  readonly fileMode: number;
  readonly dirMode: number;
};
type DiscordCli = {
  readonly done: () => void;
  readonly tmp: string;
  readonly local: string;
  readonly invoke: (
    args: readonly string[],
    options?: {
      readonly routes?: Record<string, DiscordRoute>;
      readonly environment?: Record<string, string | undefined>;
      readonly hook?: readonly string[] | null;
    },
  ) => Promise<{
    code: number;
    out: string;
    err: string;
    requests: RecordedRequest[];
    keys: string[];
    audio: AudioReceipt[];
  }>;
};

const tags = [
  { id: ids.working, name: "working" },
  { id: ids.done, name: "done" },
];
const textChannel = { id: ids.text, type: 0, name: "chat" };
const forum = { id: ids.forum, type: 15, name: "tasks", available_tags: tags };
const media = { id: ids.media, type: 16, name: "media", available_tags: tags };
const routes: Record<string, DiscordRoute> = {
  [`GET /channels/${ids.text}`]: { body: textChannel },
  [`GET /channels/${ids.forum}`]: { body: forum },
  [`GET /channels/${ids.media}`]: { body: media },
  [`GET /channels/${ids.thread}`]: { body: { id: ids.thread, type: 11, parent_id: ids.forum } },
  [`GET /guilds/${ids.guild}/channels`]: { body: [textChannel, forum, media] },
  [`POST /channels/${ids.text}/messages`]: { body: { id: ids.message } },
  [`PATCH /channels/${ids.text}/messages/${ids.message}`]: { body: { id: ids.message } },
  [`POST /channels/${ids.thread}/messages`]: { body: { id: ids.message } },
  [`PATCH /channels/${ids.thread}/messages/${ids.message}`]: { body: { id: ids.message } },
  [`POST /channels/${ids.text}/threads`]: { body: { id: ids.thread } },
  [`POST /channels/${ids.forum}/threads`]: { body: { id: ids.thread, message: { id: ids.starter } } },
  [`POST /channels/${ids.media}/threads`]: { body: { id: ids.thread } },
  [`PATCH /channels/${ids.thread}`]: { body: { id: ids.thread } },
  [`PUT /channels/${ids.thread}/messages/${ids.message}/reactions/%F0%9F%91%80/@me`]: { status: 204 },
  [`DELETE /channels/${ids.thread}/messages/${ids.message}/reactions/%F0%9F%91%80/@me`]: { status: 204 },
  [`PUT /channels/${ids.text}/messages/${ids.message}/reactions/party%3A123/@me`]: { status: 204 },
  [`DELETE /channels/${ids.text}/messages/${ids.message}/reactions/party%3A123/@me`]: { status: 204 },
  "GET /audio/voice.ogg?token=private": { raw: "audio bytes" },
};

const audioHook = `const fs = require("node:fs");
const path = require("node:path");
const file = process.argv.at(-1);
const content = fs.readFileSync(file, "utf8");
fs.appendFileSync(process.env.DORI_TEST_AUDIO_LOG, JSON.stringify({file, content,
  fileMode: fs.statSync(file).mode & 0o777, dirMode: fs.statSync(path.dirname(file)).mode & 0o777}) + "\\n");
if (process.env.DORI_TEST_TRANSCRIBE === "fail") { console.error("synthetic hook failure"); process.exit(7); }
if (process.env.DORI_TEST_TRANSCRIBE !== "empty") process.stdout.write(content);`;

/** Every scenario owns its config, routes, audio and child environment; the preload intercepts every fetch. */
const discordCli = (): DiscordCli => {
  const state = withState();
  const log = join(state.dir, "fetch.jsonl");
  const audioLog = join(state.dir, "audio.jsonl");
  const routeFile = join(state.dir, "routes.json");
  const config = join(state.dir, "config.json");
  const tmp = join(state.dir, "tmp");
  const local = join(state.dir, "local audio.ogg");
  mkdirSync(tmp, { mode: 0o700 });
  writeFileSync(local, "local transcript");
  return {
    done: state.done,
    tmp,
    local,
    invoke: async (args, options = {}) => {
      rmSync(log, { force: true });
      rmSync(audioLog, { force: true });
      writeFileSync(routeFile, JSON.stringify({ ...routes, ...options.routes }));
      writeFileSync(
        config,
        JSON.stringify({
          stateDir: state.dir,
          defaultCwd: state.dir,
          hooks: {
            transcribe:
              options.hook === null ? undefined : (options.hook ?? [process.execPath, "-e", audioHook, "{file}"]),
          },
        }),
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          join(import.meta.dir, "record-discord.ts"),
          join(import.meta.dir, "../src/cli.ts"),
          ...args,
        ],
        {
          cwd: state.dir,
          env: {
            HOME: state.dir,
            PATH: "/usr/bin:/bin",
            TMPDIR: tmp,
            DORI_CONFIG: config,
            DORI_STATE_DIR: state.dir,
            DORI_DISCORD_TOKEN: "synthetic-ops-token",
            DORI_TEST_FETCH_LOG: log,
            DORI_TEST_AUDIO_LOG: audioLog,
            DORI_TEST_DISCORD_ROUTES: routeFile,
            ...options.environment,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const requests: RecordedRequest[] = existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as RecordedRequest)
        : [];
      const audio: AudioReceipt[] = existsSync(audioLog)
        ? readFileSync(audioLog, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as AudioReceipt)
        : [];
      return { code, out: out.trim(), err: err.trim(), requests, keys: requests.map((request) => request.key), audio };
    },
  };
};

export const withDiscordCli = async (use: (fixture: DiscordCli) => Promise<void>): Promise<void> => {
  const fixture = discordCli();
  try {
    await use(fixture);
  } finally {
    fixture.done();
  }
};
