import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openOwes, recordMark, recordOwes, recordSent } from "../src/owes.ts";
import { ids, withDiscordCli } from "./discord-fakes.ts";

const inbound = (message: string) => `INBOUND discord ${ids.thread} ${message} from=owner ref=- "request"`;
const longAnswer = "verified result\n".repeat(300);

test("missing request or remote IDs are rejected before a marked owe can settle", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    const at = Date.now() - 100;
    await recordOwes(state, inbound(ids.message), at);
    await recordMark(state, ids.thread, ids.message, at + 1);
    for (const [message, remoteIds] of [
      ["", ["71"]],
      [ids.message, []],
      [ids.message, ["18446744073709551616"]],
    ] as const) {
      await expect(recordSent(state, ids.thread, message, remoteIds, at + 2)).rejects.toThrow(
        "discord send: incomplete delivery receipt; outcome uncertain",
      );
      expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
      expect(existsSync(join(state, "owes", "sent.jsonl"))).toBe(false);
    }
  });
});

test("legacy, malformed and foreign-request receipts never settle an owe", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    const at = Date.now() - 100;
    await recordOwes(state, inbound(ids.message), at);
    await recordMark(state, ids.thread, ids.message, at + 1);
    const valid = {
      deliveryId: `discord:${ids.thread}:71`,
      requestId: `${ids.thread}:${ids.message}`,
      channel: ids.thread,
      remoteIds: ["71", "72"],
      at: at + 2,
    };
    for (const receipt of [
      { channel: ids.thread, at: at + 2 },
      { ...valid, deliveryId: "another-delivery" },
      { ...valid, requestId: `${ids.thread}:99` },
      { ...valid, requestId: 123 },
      { ...valid, channel: ids.text },
      { ...valid, remoteIds: [] },
      { ...valid, remoteIds: ["71", null] },
      { ...valid, remoteIds: ["71", "71"] },
      { ...valid, remoteIds: ["71", "18446744073709551616"] },
      { ...valid, at: at - 1 },
    ]) {
      writeFileSync(join(state, "owes", "sent.jsonl"), `${JSON.stringify(receipt)}\n`);
      expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
    }
    writeFileSync(join(state, "owes", "sent.jsonl"), `${JSON.stringify(valid)}\n`);
    expect(openOwes(state, Date.now())).toEqual([]);
  });
});

test("an accepted response without a remote message ID remains uncertain", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    await recordOwes(state, inbound(ids.message), Date.now() - 100);
    await recordMark(state, ids.thread, ids.message, Date.now() - 1);
    const result = await f.invoke(
      ["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text", "answer"],
      { routes: { [`POST /channels/${ids.thread}/messages`]: { body: {} } } },
    );
    expect([result.code, result.out, result.err]).toEqual([
      1,
      "",
      "discord send: incomplete delivery receipt; outcome uncertain",
    ]);
    expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
    expect(existsSync(join(state, "owes", "sent.jsonl"))).toBe(false);
  });
}, 60_000);

test("a complete split reply settles only its exact request and retains every remote ID", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    const at = Date.now() - 100;
    for (const message of [ids.message, "99"]) {
      await recordOwes(state, inbound(message), at);
      await recordMark(state, ids.thread, message, at + 1);
    }
    const result = await f.invoke(
      ["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text", longAnswer],
      {
        routes: {
          [`POST /channels/${ids.thread}/messages`]: {
            sequence: [
              { body: { id: "71", type: 19, message_reference: { message_id: ids.message, channel_id: ids.thread } } },
              { body: { id: "72" } },
              { body: { id: "73" } },
            ],
          },
        },
      },
    );
    expect([result.code, result.err, result.out]).toEqual([0, "", "SENT 71 72 73"]);
    expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual(["99"]);
    const receipt = JSON.parse(readFileSync(join(state, "owes", "sent.jsonl"), "utf8").trim());
    expect(receipt).toMatchObject({
      deliveryId: `discord:${ids.thread}:71`,
      requestId: `${ids.thread}:${ids.message}`,
      channel: ids.thread,
      remoteIds: ["71", "72", "73"],
    });
  });
}, 60_000);

test.each([
  ["plain fallback", { id: "71", type: 0 }],
  ["wrong request", { id: "71", type: 19, message_reference: { message_id: "99", channel_id: ids.thread } }],
  ["wrong channel", { id: "71", type: 19, message_reference: { message_id: ids.message, channel_id: ids.text } }],
])("a successful %s response does not settle the request", async (_kind, body) => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    const at = Date.now() - 100;
    await recordOwes(state, inbound(ids.message), at);
    await recordMark(state, ids.thread, ids.message, at + 1);

    const result = await f.invoke(
      ["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text", "answer"],
      { routes: { [`POST /channels/${ids.thread}/messages`]: { body } } },
    );

    expect([result.code, result.err, result.out]).toEqual([0, "", "SENT 71"]);
    expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
    expect(existsSync(join(state, "owes", "sent.jsonl"))).toBe(false);
  });
});

test("an unlinked post and a reaction do not answer an existing request", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    await recordOwes(state, inbound(ids.message), Date.now() - 100);
    const reaction = await f.invoke(["react", "discord", "--thread", ids.thread, "--message", ids.message]);
    expect(reaction.code).toBe(0);
    const posted = await f.invoke(["send", "discord", "--thread", ids.thread, "--text", "unrelated update"]);
    expect(posted.code).toBe(0);
    expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
    expect(existsSync(join(state, "owes", "sent.jsonl"))).toBe(false);
  });
}, 60_000);

test("a partially accepted reply never produces a complete delivery receipt", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    const at = Date.now() - 100;
    await recordOwes(state, inbound(ids.message), at);
    await recordMark(state, ids.thread, ids.message, at + 1);
    const route = `POST /channels/${ids.thread}/messages`;
    const first = {
      body: { id: "71", type: 19, message_reference: { message_id: ids.message, channel_id: ids.thread } },
    };
    for (const { failure, uncertain } of [
      { failure: { status: 403, body: { message: "Denied" } }, uncertain: false },
      { failure: { failure: "fetch" as const }, uncertain: true },
      { failure: { status: 503, body: {} }, uncertain: true },
      { failure: { raw: "not JSON" }, uncertain: true },
      { failure: { raw: "" }, uncertain: true },
    ]) {
      const result = await f.invoke(
        ["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text", longAnswer],
        { routes: { [route]: { sequence: [first, failure, { body: { id: "73" } }] } } },
      );
      expect([result.code, result.out, result.keys]).toEqual([1, "", [route, route]]);
      expect(result.err.includes("delivery uncertain")).toBe(uncertain);
      expect(result.err).toContain("already posted: 71");
      expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
      expect(existsSync(join(state, "owes", "sent.jsonl"))).toBe(false);
    }
  });
}, 60_000);

test("an uncertain split reply reports the known IDs without settling the request", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    const at = Date.now() - 100;
    await recordOwes(state, inbound(ids.message), at);
    await recordMark(state, ids.thread, ids.message, at + 1);

    const result = await f.invoke(
      ["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text", longAnswer],
      {
        routes: {
          [`POST /channels/${ids.thread}/messages`]: {
            sequence: [
              { body: { id: "71", type: 19, message_reference: { message_id: ids.message, channel_id: ids.thread } } },
              { body: {} },
              { body: { id: "73" } },
            ],
          },
        },
      },
    );

    expect([result.code, result.out]).toEqual([1, ""]);
    expect(result.err).toBe("discord send: incomplete delivery receipt; outcome uncertain (already posted: 71 73)");
    expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
    expect(existsSync(join(state, "owes", "sent.jsonl"))).toBe(false);
  });
}, 60_000);

test.each([{}, { id: "invalid" }])(
  "a later rejection cannot make a split reply with a missing or invalid ID certain: %j",
  async (gap) => {
    await withDiscordCli(async (f) => {
      const state = dirname(f.tmp);
      const at = Date.now() - 100;
      await recordOwes(state, inbound(ids.message), at);
      await recordMark(state, ids.thread, ids.message, at + 1);
      const route = `POST /channels/${ids.thread}/messages`;
      const result = await f.invoke(
        ["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text", longAnswer.repeat(2)],
        {
          routes: {
            [route]: {
              sequence: [
                {
                  body: { id: "71", type: 19, message_reference: { message_id: ids.message, channel_id: ids.thread } },
                },
                { body: gap },
                { body: { id: "73" } },
                { status: 403, body: { message: "Denied" } },
                { body: { id: "75" } },
              ],
            },
          },
        },
      );
      expect([result.code, result.out, result.keys]).toEqual([1, "", [route, route, route, route]]);
      expect(result.err).toContain("outcome uncertain (already posted: 71 73)");
      expect(result.err).toContain("403");
      expect(result.err).toContain("do not resend");
      expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
      expect(existsSync(join(state, "owes", "sent.jsonl"))).toBe(false);
    });
  },
  60_000,
);
