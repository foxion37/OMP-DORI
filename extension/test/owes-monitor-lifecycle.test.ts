import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../../skills/cataly-mode/scripts/src/checkpoint-lock";
import { openOwes } from "../../skills/cataly-mode/scripts/src/owes";
import { BATCH_MS } from "../monitor";
import { load, until, useConfig } from "./fake-pi";

const inbound = 'INBOUND discord 20 100 from=owner ref=- "question"';
const setup = async () => {
  const root = useConfig();
  const pi = await load({ session: { id: "s1", entries: [] }, flags: { "cataly-role": "cataly" } });
  await pi.emit("session_start");
  mkdirSync(join(root, "owes"), { recursive: true, mode: 0o700 });
  const held = takeLock(join(root, "owes", "inbound.jsonl.lock"), Date.now(), (message) => new Error(message));
  if (typeof held === "string") throw new Error(held);
  try {
    await pi.tools.get("monitor")!.execute(
      "call",
      {
        op: "start",
        name: "inbound",
        filter: "^INBOUND",
        argv: [process.execPath, "--eval", `console.log(${JSON.stringify(inbound)});setInterval(()=>{},1000)`],
      },
      undefined,
      undefined,
      pi.ctx(),
    );
    // This integration exercises the real child pipe and production debounce; fake time cannot drive either.
    await Bun.sleep(BATCH_MS * 2);
    return { root, pi, release: held };
  } catch (error) {
    held();
    await pi.emit("session_shutdown");
    throw error;
  }
};

afterEach(() => {
  delete process.env.CATALY_CONFIG;
});

test("a synchronous settle does not wait for a file lock, and subsequent admission wakes a new turn", async () => {
  const { root, pi, release } = await setup();
  let held = true;
  try {
    expect(pi.messages).toEqual([]);
    expect(openOwes(root, Date.now())).toEqual([]);
    const handler = pi.handlers.get("session_stop")![0]!;
    const result = handler({ type: "session_stop" }, pi.ctx());
    expect(result).toBeUndefined();
    release();
    held = false;
    await until(() => pi.messages.length > 0);
    expect(openOwes(root, Date.now()).map((owe) => owe.message)).toEqual(["100"]);
    expect(pi.messages[0]?.content).toContain(inbound);
    expect(pi.messages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "aside" });
    const blocked = handler({ type: "session_stop" }, pi.ctx());
    expect(blocked).toEqual(expect.objectContaining({ continue: true }));
  } finally {
    await pi.emit("session_shutdown");
    if (held) release();
  }
});

for (const ending of ["session_switch", "session_shutdown"] as const) {
  test(`${ending} cancels a waiting real extension admission without stale publication`, async () => {
    const { root, pi, release } = await setup();
    let held = true;
    try {
      if (ending === "session_switch") {
        pi.session.id = "s2";
        pi.session.entries = [];
      }
      await pi.emit(ending);
      release();
      held = false;
      // Outlast the real 50ms lock retry: without the delivery signal, an owe would be published after release.
      await Bun.sleep(BATCH_MS);
      expect(pi.messages).toEqual([]);
      expect(openOwes(root, Date.now())).toEqual([]);
    } finally {
      await pi.emit("session_shutdown");
      if (held) release();
    }
  });
}
