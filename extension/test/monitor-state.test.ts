import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FakePi, load, useConfig } from "./fake-pi";

test("boot metadata survives shutdown and restoration, then forgets an explicitly stopped monitor", async () => {
  const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  const previousPane = process.env.HERDR_PANE_ID;
  const previousTerminal = process.env.HC_TERMINAL_ID;
  process.env.HERDR_PANE_ID = "w1:p9";
  delete process.env.HC_TERMINAL_ID;
  const session = { id: "monitor-owner", file: "/sessions/monitor-owner.jsonl", entries: [] };
  const path = join(stateDir, "monitors", "monitor-owner.json");
  const argv = ["sh", "-c", "exec sleep 30"];
  const first = await load({ session, flags: { "dori-role": "dori" } });
  let resumed: FakePi | undefined;
  try {
    await first.emit("session_start");
    await first.tools
      .get("monitor")!
      .execute("start", { op: "start", name: "closed-lane", argv, filter: "." }, undefined, undefined, first.ctx());
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 1,
      sessionId: session.id,
      monitors: [{ name: "closed-lane", argv, filter: "." }],
    });
    await first.emit("session_shutdown");
    expect(JSON.parse(readFileSync(path, "utf8")).monitors[0].name).toBe("closed-lane");
    resumed = await load({ session });
    await resumed.emit("session_start");
    expect(JSON.parse(readFileSync(path, "utf8")).monitors[0].name).toBe("closed-lane");
    await resumed.tools
      .get("monitor")!
      .execute("stop", { op: "stop", name: "closed-lane" }, undefined, undefined, resumed.ctx());
    expect(JSON.parse(readFileSync(path, "utf8")).monitors).toEqual([]);
  } finally {
    await resumed?.emit("session_shutdown");
    await first.emit("session_shutdown");
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
    if (previousTerminal === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = previousTerminal;
  }
});
