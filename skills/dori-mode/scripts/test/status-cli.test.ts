import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { ids, withDiscordCli } from "./discord-fakes.ts";

// Board writes fsync their directory, which Bun on Windows rejects.
const posix = test.skipIf(process.platform === "win32");
const demoLane = {
  key: "status-demo",
  title: "Demo",
  thread: "discord:40",
  openedAt: "2026-01-01T00:00:00Z",
  brief: "/brief",
  done: "file /done",
};

test("actual status and ETA CLI show read-only JSON and text", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    await new Registry(stateDir).write(demoLane);
    new Reports(stateDir).report(demoLane.key, "milestone", "First increment", Date.parse(demoLane.openedAt));
    const json = await f.invoke(["status", "--json"]);
    expect([json.code, json.err, json.keys]).toEqual([0, "", []]);
    expect(JSON.parse(json.out).lanes[0]).toMatchObject({ key: demoLane.key, runtime: null });
    const text = await f.invoke(["status", demoLane.key]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("First increment");
    expect(text.out).toContain("(read-only)");
    const eta = await f.invoke(["eta", "status-", "--json"]);
    expect(JSON.parse(eta.out)).toMatchObject({ samples: 0, medianMinutes: null });
  });
});

posix("actual board CLI posts and edits the same board across subprocesses", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    await new Registry(stateDir).write(demoLane);
    const reports = new Reports(stateDir);
    reports.report(demoLane.key, "milestone", "First increment", Date.parse(demoLane.openedAt));
    const args = ["board", "discord", "--thread", ids.thread, "--loop", "0"];
    const first = await f.invoke(args);
    expect([first.code, first.err, first.out, first.keys]).toEqual([
      0,
      "",
      "BOARD discord posted 50",
      [`POST /channels/${ids.thread}/messages`],
    ]);
    const same = await f.invoke(args);
    expect([same.code, same.out, same.keys]).toEqual([0, "BOARD discord unchanged 50", []]);
    reports.report(demoLane.key, "question", "Choose next", Date.parse(demoLane.openedAt) + 60_000);
    const changed = await f.invoke(args);
    expect([changed.code, changed.out, changed.keys]).toEqual([
      0,
      "BOARD discord edited 50",
      [`PATCH /channels/${ids.thread}/messages/50`],
    ]);
    expect(changed.requests[0]?.body?.["content"]).toContain("blocked");
  });
});

for (const command of ["status", "board", "eta"] as const) {
  const check = command === "board" ? posix : test;
  check(`actual ${command} CLI exposes incomplete registry without losing healthy data`, async () => {
    await withDiscordCli(async (f) => {
      const registry = new Registry(dirname(f.tmp));
      const lane = {
        key: "healthy",
        title: "Healthy",
        thread: "discord:40",
        openedAt: "2026-01-01T00:00:00Z",
        brief: "brief",
        done: "file proof",
      };
      await registry.write(lane);
      for (let i = 0; i < 3; i++)
        await registry.write({ ...lane, key: `healthy-${i}`, closedAt: "2026-01-01T01:00:00Z" });
      writeFileSync(registry.path("damaged"), "{broken");
      const args =
        command === "board"
          ? [command, "discord", "--thread", ids.thread]
          : command === "eta"
            ? [command, "healthy", "--json"]
            : [command, "--json"];
      const result = await f.invoke(args);
      expect([result.code, result.err]).toEqual([0, ""]);
      if (command === "board") expect(result.requests[0]?.body?.["content"]).toContain("incomplete");
      else {
        const json = JSON.parse(result.out);
        expect(json.registryIncomplete).toBe(true);
        if (command === "eta") expect(json).toMatchObject({ samples: 3, medianMinutes: null });
        else expect(json.lanes.map((item: { key: string }) => item.key)).toEqual([lane.key]);
        expect(result.keys).toEqual([]);
      }
    });
  });
}

test("board CLI refuses malformed targets, recovery IDs and loops before any request", async () => {
  await withDiscordCli(async (f) => {
    for (const args of [
      ["eta", ""],
      ["board", "discord", "--to", ids.text, "--thread", ids.thread],
      ["board", "discord", "--thread", ""],
      ["board", "discord", "--to", "../else"],
      ["board", "discord", "--thread", ids.thread, "--message", ""],
      ["board", "discord", "--thread", ids.thread, "--loop", "5m"],
      ["board", "telegram", "--to", "-100", "--thread", "bad"],
      ["board", "telegram", "--to", "-100", "--message", "9007199254740992"],
    ]) {
      const result = await f.invoke(args, { environment: { DORI_TELEGRAM_TOKEN: "synthetic-telegram-token" } });
      expect(result.code).toBe(1);
      expect(result.keys).toEqual([]);
      expect(existsSync(join(dirname(f.tmp), "boards"))).toBe(false);
    }
    const missing = await f.invoke(["status", "unknown"]);
    expect([missing.code, missing.err]).toEqual([1, "no registered lane unknown"]);
  });
});

const boardInputCases = [
  ["shared dry-run", ["--dry-run"]],
  ["shared flag with value", ["--text", "unused"]],
  ["unknown flag", ["--lnae=healthy"]],
  ["extra positional", ["healthy"]],
  ["extra positional after terminator", ["--", "healthy"]],
  ["missing lane value", ["--lane"]],
  ["empty lane value", ["--lane="]],
  ["blank lane value", ["--lane", "  "]],
  ["malformed lane value", ["--lane", "../healthy"]],
  ["option in lane value position", ["--lane", "--dry-run"]],
  ["duplicate lane", ["--lane=", "--lane", "healthy"]],
  ["nonexistent lane", ["--lane", "unknown"]],
] as const;

test.each(boardInputCases)("board rejects %s without HTTP or board state", async (_label, extra) => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    const registry = new Registry(stateDir);
    await registry.write({
      key: "healthy",
      title: "Healthy",
      thread: "discord:40",
      openedAt: "2026-01-01T00:00:00Z",
      brief: "brief",
      done: "file proof",
    });
    const result = await f.invoke(["board", "discord", "--thread", ids.thread, ...extra]);
    expect({ code: result.code, requests: result.requests, boardState: existsSync(join(stateDir, "boards")) }).toEqual({
      code: 1,
      requests: [],
      boardState: false,
    });
  });
});

test("board rejects unsupported arguments before reading credentials", async () => {
  await withDiscordCli(async (f) => {
    const result = await f.invoke(["board", "discord", "--thread", ids.thread, "--dry-run"], {
      environment: { DORI_DISCORD_TOKEN: undefined },
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("--dry-run");
    expect(result.requests).toEqual([]);
    expect(existsSync(join(dirname(f.tmp), "boards"))).toBe(false);
  });
});

posix("Telegram board keeps signed chat IDs, topic, explicit lane and recovery options", async () => {
  await withDiscordCli(async (f) => {
    const registry = new Registry(dirname(f.tmp));
    const lane = {
      key: "included",
      title: "Included lane",
      thread: "telegram:-100",
      openedAt: "2026-01-01T00:00:00Z",
      brief: "brief",
      done: "file proof",
    };
    await registry.write(lane);
    await registry.write({ ...lane, key: "excluded", title: "Excluded lane" });

    const token = "synthetic-telegram-token";
    const args = ["board", "telegram", "--to", "-100", "--thread=42", "--loop", "0", "--lane", lane.key];
    const environment = { DORI_TELEGRAM_TOKEN: token };
    const send = `POST /bot${token}/sendMessage`;
    const posted = await f.invoke(args, {
      environment,
      routes: { [send]: { body: { ok: true, result: { message_id: 50 } } } },
    });
    expect([posted.code, posted.err, posted.out, posted.keys]).toEqual([0, "", "BOARD telegram posted 50", [send]]);
    expect(posted.requests[0]?.body).toMatchObject({ chat_id: "-100", message_thread_id: 42 });

    new Reports(dirname(f.tmp)).report(lane.key, "milestone", "Now ready", Date.parse("2026-01-01T00:01:00Z"));
    const route = `POST /bot${token}/editMessageText`;
    const result = await f.invoke([...args, "--message", "50"], {
      environment,
      routes: { [route]: { body: { ok: true, result: true } } },
    });
    expect([result.code, result.out, result.keys]).toEqual([0, "BOARD telegram edited 50", [route]]);
    const body = result.requests[0]?.body;
    expect(body).toMatchObject({ chat_id: "-100", message_id: 50 });
    expect(body?.["text"]).toContain("included |");
    expect(body?.["text"]).not.toContain("excluded |");
  });
});
