import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

for (const mode of ["once", "daemon"] as const) {
  test(`${mode} completion waits for real owner admission before sealing or retrying`, async () => {
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
          mode,
          filter: "^INBOUND",
          ...(mode === "daemon" ? { restart: { max: 1, backoffSec: 0.01 } } : {}),
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
      // Keep the actual lock beyond the production debounce and a daemon retry.
      await Bun.sleep(BATCH_MS * 2);
      expect(recordedMonitorStates(pi.session.entries).get("finite")?.completed).toBe(false);
      expect(recordedMonitorStates(pi.session.entries).get("finite")?.exit).toBeUndefined();
      expect(readFileSync(marker, "utf8")).toBe("run");
      expect(pi.messages).toEqual([]);
      expect(openOwes(root, Date.now())).toEqual([]);
      lock();
      held = false;
      await until(() => recordedMonitorStates(pi.session.entries).get("finite")?.completed === true);
      await until(() => pi.messages.some((message) => message.content.includes(inbound)));
      expect(openOwes(root, Date.now()).map((owe) => owe.message)).toEqual(["100"]);
      expect(readFileSync(marker, "utf8")).toBe(mode === "once" ? "run" : "runrun");
    } finally {
      await pi.emit("session_shutdown");
      if (held) lock();
    }
  });
}

test("an exited child waiting on bounded delivery is not reported as healthy", async () => {
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
        mode: "daemon",
        restart: { max: 1, backoffSec: 0.01 },
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
    // Windows may report the PID gone before Bun has delivered its subprocess exit notification.
    await until(() => monitors.list(true)[0]?.waiting === true);
    expect(receipts).toBe(0);
    expect(monitors.list()).toEqual([]);
    expect(monitors.list(true)[0]).toMatchObject({ waiting: true });
    resume.resolve();
    await until(() => receipts === 2 && monitors.list(true).length === 0);
  } finally {
    monitors.stopAll();
    resume.resolve();
  }
});
