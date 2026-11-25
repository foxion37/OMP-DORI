import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../../skills/cataly-mode/scripts/src/checkpoint-lock";
import { openOwes } from "../../skills/cataly-mode/scripts/src/owes";
import { BATCH_MS, Monitors } from "../monitor";
import { load, until, useConfig } from "./fake-pi";

const command = (text: string) => [
  process.execPath,
  "--eval",
  `console.log(${JSON.stringify(text)});setInterval(()=>{},1000)`,
];

afterEach(() => {
  delete process.env.CATALY_CONFIG;
});

test("a failed routine-only delivery wakes for its failure report", async () => {
  const delivered: Array<{ text: string; wake: boolean }> = [];
  const monitors = new Monitors(
    async (text, delivery) => {
      delivered.push({ text, wake: delivery.wake });
      if (delivered.length === 1) throw new Error("fixture delivery rejected");
    },
    () => "s1",
    10,
  );
  try {
    monitors.start("notice", command("LANE_WATCH_READY"), ".", "/", "s1");
    await until(() => delivered.length === 2);
    expect(delivered[0]).toEqual({ text: "[notice] LANE_WATCH_READY", wake: false });
    expect(delivered[1]?.text).toContain("delivery failed");
    expect(delivered[1]?.text).toContain("fixture delivery rejected");
    expect(delivered[1]?.wake).toBe(true);
    expect(monitors.list()).toEqual([]);
  } finally {
    monitors.stopAll();
  }
});

for (const line of ["LANE_WATCH_READY", "WARN disk"] as const) {
  for (const ending of ["session_switch", "session_shutdown"] as const) {
    test(`${ending} cancels an admitted batch containing ${line} without waking`, async () => {
      const root = useConfig();
      const pi = await load({ session: { id: "s1", entries: [] }, flags: { "cataly-role": "cataly" } });
      await pi.emit("session_start");
      mkdirSync(join(root, "owes"), { recursive: true, mode: 0o700 });
      const held = takeLock(join(root, "owes", "inbound.jsonl.lock"), Date.now(), (message) => new Error(message));
      if (typeof held === "string") throw new Error(held);
      let locked = true;
      try {
        const inbound = 'INBOUND discord 20 100 from=owner ref=- "question"';
        await pi.tools
          .get("monitor")!
          .execute(
            "call",
            { op: "start", name: "mixed", filter: ".", argv: command(`${line}\n${inbound}`) },
            undefined,
            undefined,
            pi.ctx(),
          );
        // Real child pipes, the production debounce and the real admission lock.
        await Bun.sleep(BATCH_MS * 2);
        expect(pi.messages).toEqual([]);
        expect(openOwes(root, Date.now())).toEqual([]);
        if (ending === "session_switch") {
          pi.session.id = "s2";
          pi.session.entries = [];
        }
        await pi.emit(ending);
        held();
        locked = false;
        // Outlast the real admission retry after releasing the lock.
        await Bun.sleep(BATCH_MS);
        expect(pi.messages).toEqual([]);
        expect(openOwes(root, Date.now())).toEqual([]);
      } finally {
        await pi.emit("session_shutdown");
        if (locked) held();
      }
    });
  }
}
