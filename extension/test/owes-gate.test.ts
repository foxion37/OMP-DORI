import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_CONTINUATIONS,
  openOwes,
  recordMark,
  recordOwes,
  recordSent,
} from "../../skills/cataly-mode/scripts/src/owes";
import { type FakePi, load, until, useConfig } from "./fake-pi";

const CHANNEL = "1570973386363117651";
const inbound = (message: string, text = "배포 왜 안 됨") =>
  `INBOUND discord ${CHANNEL} ${message} from=owner ref=- ${JSON.stringify(text)}`;

let stateDir: string;
beforeEach(() => {
  stateDir = useConfig();
  delete process.env.CATALY_HEADLESS_ID;
});
afterEach(() => {
  delete process.env.CATALY_CONFIG;
});

type StopResult = { continue?: boolean; additionalContext?: string };

const catalySession = async (): Promise<FakePi> => {
  const pi = await load({ session: { id: "s1", entries: [] }, flags: { "cataly-role": "cataly" } });
  await pi.emit("session_start");
  return pi;
};

const stop = async (pi: FakePi): Promise<StopResult | undefined> =>
  (await pi.emit("session_stop"))[0] as StopResult | undefined;

describe("session_stop owes gate", () => {
  test("an owner message with no Discord answer blocks the settle and names the command", async () => {
    const pi = await catalySession();
    expect(await stop(pi)).toBeUndefined();

    await recordOwes(stateDir, inbound("100"), Date.now());
    const blocked = await stop(pi);
    expect(blocked?.continue).toBe(true);
    expect(blocked?.additionalContext).toContain("cataly send discord --to <channel>");
    expect(blocked?.additionalContext).toContain("owner message 100");
  });

  test("a send receipt alone leaves the settle blocked until the read receipt is recorded too", async () => {
    const pi = await catalySession();
    const at = Date.now();
    await recordOwes(stateDir, inbound("100"), at);
    expect((await stop(pi))?.continue).toBe(true);

    await recordSent(stateDir, CHANNEL, "100", ["701"], at + 1);
    const stillBlocked = await stop(pi);
    expect(stillBlocked?.continue).toBe(true);
    expect(stillBlocked?.additionalContext).toContain(`cataly react discord --to ${CHANNEL} --message 100`);

    await recordMark(stateDir, CHANNEL, "100", at + 2);
    expect(await stop(pi)).toBeUndefined();
  });

  test("answering one request does not settle another request in the same channel", async () => {
    const pi = await catalySession();
    const at = Date.now();
    for (const message of ["100", "200"]) {
      await recordOwes(stateDir, inbound(message), at);
      await recordMark(stateDir, CHANNEL, message, at + 1);
    }
    await recordSent(stateDir, CHANNEL, "100", ["701", "702"], at + 2);
    const blocked = await stop(pi);
    expect(blocked?.continue).toBe(true);
    expect(blocked?.additionalContext).toContain("owner message 200");
    expect(blocked?.additionalContext).not.toContain("owner message 100");
    expect(blocked?.additionalContext).toContain("--reply <owner message id>");
    await recordSent(stateDir, CHANNEL, "200", ["703"], at + 3);
    expect(await stop(pi)).toBeUndefined();
  });

  test("a lane session is never gated: the messenger is the only one that owes the owner", async () => {
    const pi = await load({ session: { id: "s1", entries: [] }, flags: { "cataly-role": "lane" } });
    await pi.emit("session_start");
    await recordOwes(stateDir, inbound("100"), Date.now());
    expect(await stop(pi)).toBeUndefined();
  });

  test("a subagent of the Cataly session is not gated", async () => {
    const pi = await load({
      session: { id: "s1", entries: [] },
      flags: { "cataly-role": "cataly" },
      agent: { kind: "sub", id: "Sub", parentId: "main" },
    });
    await pi.emit("session_start");
    await recordOwes(stateDir, inbound("100"), Date.now());
    expect(await stop(pi)).toBeUndefined();
  });

  test("the gate gives up after MAX_CONTINUATIONS instead of looping a wedged session forever", async () => {
    const pi = await catalySession();
    await recordOwes(stateDir, inbound("100"), Date.now());
    for (let i = 0; i < MAX_CONTINUATIONS; i++) expect((await stop(pi))?.continue).toBe(true);
    expect(await stop(pi)).toBeUndefined();
  });

  test("a monitor line is recorded as an owe through the real delivery path, not only the CLI writer", async () => {
    const pi = await catalySession();
    const tool = pi.tools.get("monitor")!;
    try {
      await tool.execute(
        "call",
        {
          op: "start",
          name: "inbound",
          argv: ["sh", "-c", `echo '${inbound("200")}'; exec sleep 30`],
          filter: "^INBOUND",
        },
        undefined,
        undefined,
        pi.ctx(),
      );
      await until(() => openOwes(stateDir, Date.now()).length > 0);
      expect(pi.messages[0]?.content).toContain(`INBOUND discord ${CHANNEL} 200 from=owner`);
      expect(openOwes(stateDir, Date.now()).map((owe) => owe.message)).toEqual(["200"]);
      const blocked = await stop(pi);
      expect(blocked?.additionalContext).toContain("owner message 200");
    } finally {
      await pi.emit("session_shutdown");
    }
  });

  test("a torn ledger cannot stop the session from settling", async () => {
    const pi = await catalySession();
    mkdirSync(join(stateDir, "owes"), { recursive: true });
    writeFileSync(join(stateDir, "owes", "inbound.jsonl"), '{"id":"broken\n');
    expect(await stop(pi)).toBeUndefined();
  });
});
