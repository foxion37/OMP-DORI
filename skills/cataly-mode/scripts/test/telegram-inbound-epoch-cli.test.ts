import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

type Update = { update_id: number; message?: unknown; edited_message?: unknown };
const owner = 5250;
const posix = test.skipIf(process.platform === "win32");
const message = (update: number, id: number, text: string): Update => ({
  update_id: update,
  message: { message_id: id, date: 1_700_000_000, from: { id: owner }, chat: { id: owner, type: "private" }, text },
});
const cursorPath = (dir: string, bot = 900) => join(dir, "telegram-inbound", `${bot}.json`);

const run = async (
  dir: string,
  updates: Update[],
  options: { token?: string; bot?: number; identityFailure?: boolean } = {},
) => {
  const token = options.token ?? "synthetic-telegram-epoch";
  const config = join(dir, "config.json");
  const journal = join(dir, "telegram-requests.jsonl");
  writeFileSync(config, JSON.stringify({ stateDir: dir, hooks: {} }));
  writeFileSync(journal, "", { mode: 0o600 });
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "record-telegram-epoch.ts"),
      join(import.meta.dir, "../src/cli.ts"),
      "inbound",
      "telegram",
      "--loop",
      "0",
    ],
    {
      env: {
        HOME: dir,
        PATH: "/usr/bin:/bin",
        CATALY_CONFIG: config,
        CATALY_STATE_DIR: dir,
        CATALY_TELEGRAM_TOKEN: token,
        CATALY_TELEGRAM_OWNER_ID: String(owner),
        CATALY_TEST_TELEGRAM_UPDATES: JSON.stringify(updates),
        CATALY_TEST_TELEGRAM_REQUESTS: journal,
        CATALY_TEST_TELEGRAM_BOT: JSON.stringify({ id: options.bot ?? 900, is_bot: true, first_name: "Epoch fixture" }),
        CATALY_TEST_TELEGRAM_IDENTITY_FAILURE: options.identityFailure ? "1" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(`${out}\n${err}`).not.toContain(token);
  const requests = readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  return { out, err, code, requests, inbound: out.split("\n").filter((line) => line.startsWith("INBOUND ")) };
};

posix("a first start polls without an offset and saves a private versioned cursor", async () => {
  const state = withState();
  try {
    const result = await run(state.dir, [message(5, 41, "new epoch")]);
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
    expect(result.inbound).toEqual(['INBOUND dm 5250 - 5 mid=41 5250 "new epoch"']);
    expect(result.requests.map((request) => request.method)).toEqual([
      "getMe",
      "getWebhookInfo",
      "getUserProfilePhotos",
      "getUpdates",
      "setMessageReaction",
    ]);
    expect(result.requests.find((request) => request.method === "getUpdates")?.params).not.toHaveProperty("offset");
    const saved = JSON.parse(readFileSync(cursorPath(state.dir), "utf8"));
    expect(saved).toMatchObject({ version: 1, botId: 900, offset: 6 });
    expect(saved.seen).toHaveLength(1);
    expect(statSync(join(state.dir, "telegram-inbound")).mode & 0o777).toBe(0o700);
    expect(statSync(cursorPath(state.dir)).mode & 0o777).toBe(0o600);
  } finally {
    state.done();
  }
});

const timeCases = [undefined, "invalid", null, -1, -86_400_000, 86_400_000] as const;
posix.each(timeCases)("an expired, missing, invalid or future observation omits offset: %j", async (observation) => {
  const state = withState();
  try {
    expect((await run(state.dir, [message(1000, 41, "old epoch")])).inbound).toHaveLength(1);
    const saved = JSON.parse(readFileSync(cursorPath(state.dir), "utf8"));
    saved.observedAt =
      observation === -86_400_000 || observation === 86_400_000 ? Date.now() + observation : observation;
    writeFileSync(cursorPath(state.dir), JSON.stringify(saved));
    const result = await run(state.dir, [message(5, 42, "new epoch")]);
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
    expect(result.requests.find((request) => request.method === "getUpdates")?.params).not.toHaveProperty("offset");
    expect(result.inbound).toEqual(['INBOUND dm 5250 - 5 mid=42 5250 "new epoch"']);
    expect(JSON.parse(readFileSync(cursorPath(state.dir), "utf8")).offset).toBe(6);
  } finally {
    state.done();
  }
});

posix("clock rollback replays no stable message or reaction, including after token rotation", async () => {
  const state = withState();
  try {
    const first = message(100, 41, "already delivered");
    expect((await run(state.dir, [first])).inbound).toHaveLength(1);
    const saved = JSON.parse(readFileSync(cursorPath(state.dir), "utf8"));
    saved.observedAt = Date.now() + 86_400_000;
    writeFileSync(cursorPath(state.dir), JSON.stringify(saved));
    const again = await run(state.dir, [first, message(101, 42, "next")], { token: "rotated-synthetic-token" });
    expect(again.inbound).toEqual(['INBOUND dm 5250 - 101 mid=42 5250 "next"']);
    expect(again.requests.filter((request) => request.method === "setMessageReaction")).toHaveLength(1);
    expect(again.requests.find((request) => request.method === "getUpdates")?.params).not.toHaveProperty("offset");
  } finally {
    state.done();
  }
});

posix("an authenticated bot change cannot borrow another bot's fresh offset", async () => {
  const state = withState();
  try {
    await run(state.dir, [message(1000, 41, "bot one")]);
    const original = readFileSync(cursorPath(state.dir), "utf8");
    const other = await run(state.dir, [message(5, 41, "bot two")], { bot: 901 });
    expect(other.inbound).toEqual(['INBOUND dm 5250 - 5 mid=41 5250 "bot two"']);
    expect(other.requests.find((request) => request.method === "getUpdates")?.params).not.toHaveProperty("offset");
    expect(readFileSync(cursorPath(state.dir), "utf8")).toBe(original);
    const resumed = await run(state.dir, [message(1001, 42, "bot one again")]);
    expect(resumed.requests.find((request) => request.method === "getUpdates")?.params["offset"]).toBe(1001);
    expect(resumed.inbound).toEqual(['INBOUND dm 5250 - 1001 mid=42 5250 "bot one again"']);
  } finally {
    state.done();
  }
});

posix("failed bot identity lookup never polls or reflects an API error body", async () => {
  const state = withState();
  try {
    const result = await run(state.dir, [message(5, 41, "not authenticated")], { identityFailure: true });
    expect(result.inbound).toEqual([]);
    expect(result.requests.map((request) => request.method)).toEqual(["getMe"]);
    expect(result.code).toBe(1);
    expect(result.out).not.toContain("INBOUND_READY");
    expect(result.err).toContain("bot identity could not be verified");
    expect(result.err).not.toContain("private");
  } finally {
    state.done();
  }
});
