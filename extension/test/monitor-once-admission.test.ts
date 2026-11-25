import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../../skills/cataly-mode/scripts/src/checkpoint-lock.ts";
import { openOwes } from "../../skills/cataly-mode/scripts/src/owes.ts";
import { BATCH_MS, Monitors } from "../monitor.ts";
import { recordedMonitorStates } from "../monitor-state.ts";
import { load, until, useConfig } from "./fake-pi.ts";

const inbound = 'INBOUND discord 20 100 from=owner ref=- "question"';
afterEach(() => {
  delete process.env.CATALY_CONFIG;
});

test("once completion waits for real owner admission before sealing", async () => {
  const root = useConfig();
  const pi = await load({ session: { id: "owner", entries: [] }, flags: { "cataly-role": "cataly" } });
  await pi.emit("session_start");
  mkdirSync(join(root, "owes"), { recursive: true, mode: 0o700 });
  const lock = takeLock(join(root, "owes", "inbound.jsonl.lock"), Date.now(), (message) => new Error(message));
  if (typeof lock === "string") throw new Error(lock);
  let held = true;
  const marker = join(root, "runs");
  try {
    await pi.tools.get("monitor")!.execute(
      "start",
      {
        op: "start",
        name: "finite",
        mode: "once",
        filter: "^INBOUND",
        argv: [
          process.execPath,
          "--eval",
          `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run'); console.log(${JSON.stringify(inbound)})`,
        ],
      },
      undefined,
      undefined,
      pi.ctx(),
    );
    await until(() => existsSync(marker));
    await Bun.sleep(BATCH_MS * 2);
    expect(recordedMonitorStates(pi.session.entries).get("finite")?.completed).toBe(false);
    expect(recordedMonitorStates(pi.session.entries).get("finite")?.exit).toBeUndefined();
    expect(readFileSync(marker, "utf8")).toBe("run");
    await pi.emit("session_tree");
    expect(pi.messages).toEqual([]);
    expect(openOwes(root, Date.now())).toEqual([]);
    lock();
    held = false;
    await until(() => recordedMonitorStates(pi.session.entries).get("finite")?.completed === true);
    await until(() => pi.messages.some((message) => message.content.includes(inbound)));
    expect(openOwes(root, Date.now()).map((owe) => owe.message)).toEqual(["100"]);
    expect(readFileSync(marker, "utf8")).toBe("run");
  } finally {
    await pi.emit("session_shutdown");
    if (held) lock();
  }
});

test("failed owner admission retains unfinished once intent", async () => {
  const root = useConfig();
  const pi = await load({ session: { id: "owner", entries: [] }, flags: { "cataly-role": "cataly" } });
  await pi.emit("session_start");
  writeFileSync(join(root, "owes"), "block admission storage");
  try {
    await pi.tools.get("monitor")!.execute(
      "start",
      {
        op: "start",
        name: "finite",
        mode: "once",
        filter: "^INBOUND",
        argv: [process.execPath, "--eval", `console.log(${JSON.stringify(inbound)})`],
      },
      undefined,
      undefined,
      pi.ctx(),
    );
    await until(() => pi.messages.some((message) => message.content.includes("delivery failed")));
    expect(recordedMonitorStates(pi.session.entries).get("finite")?.completed).toBe(false);
    expect(recordedMonitorStates(pi.session.entries).get("finite")?.exit).toBeUndefined();
    expect(pi.messages.some((message) => message.content.includes(inbound))).toBe(false);
  } finally {
    await pi.emit("session_shutdown");
  }
});

test("an exited once child waiting on bounded delivery is not a live health PID", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let receipts = 0;
  const monitors = new Monitors(
    async () => {
      entered.resolve();
      await resume.promise;
    },
    () => "owner",
    10,
  );
  try {
    const started = monitors.start(
      "draining",
      [process.execPath, "--eval", 'await Bun.write(Bun.stdout, "hit\\n".repeat(100));'],
      ".",
      "/",
      "owner",
      {
        mode: "once",
        onExit: () => {
          receipts++;
        },
      },
    );
    await entered.promise;
    await until(() => {
      try {
        process.kill(started.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(receipts).toBe(0);
    expect(monitors.list()).toEqual([]);
    resume.resolve();
    await until(() => receipts === 1);
  } finally {
    monitors.stopAll();
    resume.resolve();
  }
});
