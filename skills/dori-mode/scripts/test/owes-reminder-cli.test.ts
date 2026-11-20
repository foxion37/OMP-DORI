import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { openOwes, recordOwes, recordSent, reminder } from "../src/owes.ts";
import { ids, withDiscordCli } from "./discord-fakes.ts";

const inbound = (message: string) => `INBOUND discord ${ids.text} ${message} from=owner ref=- "question"`;
const commands = (root: string) =>
  reminder(openOwes(root, Date.now()))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("dori react discord "));
const reactionPath = (message: string) => `/channels/${ids.text}/messages/${message}/reactions/%F0%9F%91%80/@me`;
const confirmedReply = {
  routes: {
    [`POST /channels/${ids.text}/messages`]: {
      body: { id: ids.message, type: 19, message_reference: { message_id: "100", channel_id: ids.text } },
    },
  },
};

test("the reminder's exact mark commands run through the real CLI and settle every named obligation", async () => {
  await withDiscordCli(async (f) => {
    const root = dirname(f.tmp);
    await recordOwes(root, [inbound("100"), inbound("101")].join("\n"), Date.now());
    const marks = commands(root);
    expect(marks).toEqual([
      `dori react discord --to ${ids.text} --message 100`,
      `dori react discord --to ${ids.text} --message 101`,
    ]);
    const sent = await f.invoke(
      ["send", "discord", "--to", ids.text, "--reply", "100", "--text", "the answer"],
      confirmedReply,
    );
    expect([sent.code, sent.err, sent.out]).toEqual([0, "", `SENT ${ids.message}`]);
    expect(openOwes(root, Date.now()).map((owe) => owe.message)).toEqual(["100", "101"]);
    // Each request now needs its own accepted reply before its mark can settle it.
    await recordSent(root, ids.text, "101", ["701"], Date.now());
    for (const [index, mark] of marks.entries()) {
      const result = await f.invoke(mark.split(" ").slice(1), {
        routes: { [`PUT ${reactionPath(String(100 + index))}`]: { status: 204 } },
      });
      expect([result.code, result.err, result.out]).toEqual([0, "", `REACTED ${ids.text} +`]);
      expect(result.keys).toEqual([`PUT ${reactionPath(String(100 + index))}`]);
      expect(openOwes(root, Date.now()).map((owe) => owe.message)).toEqual(index === 0 ? ["101"] : []);
    }
  });
});

test("the real reminder command needs an accepted added reaction, not a removal or refused request", async () => {
  await withDiscordCli(async (f) => {
    const root = dirname(f.tmp);
    await recordOwes(root, inbound("100"), Date.now());
    const marks = commands(root);
    expect(marks).toEqual([`dori react discord --to ${ids.text} --message 100`]);
    const args = marks[0]!.split(" ").slice(1);
    const sent = await f.invoke(
      ["send", "discord", "--to", ids.text, "--reply", "100", "--text", "the answer"],
      confirmedReply,
    );
    expect(sent.code).toBe(0);
    const removed = await f.invoke([...args, "--remove"], {
      routes: { [`DELETE ${reactionPath("100")}`]: { status: 204 } },
    });
    expect([removed.code, removed.out]).toEqual([0, `REACTED ${ids.text} -`]);
    expect(openOwes(root, Date.now())).toHaveLength(1);
    const refused = await f.invoke(args, {
      routes: { [`PUT ${reactionPath("100")}`]: { status: 403, body: { message: "Denied" } } },
    });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("403");
    expect(openOwes(root, Date.now())).toHaveLength(1);
    const added = await f.invoke(args, { routes: { [`PUT ${reactionPath("100")}`]: { status: 204 } } });
    expect([added.code, added.out]).toEqual([0, `REACTED ${ids.text} +`]);
    expect(openOwes(root, Date.now())).toEqual([]);
  });
});
