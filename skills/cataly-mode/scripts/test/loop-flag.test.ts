import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { refusedOnWindows, withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

test("watch commands refuse a --loop that is not a number of minutes instead of polling back to back", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const invoke = (...args: string[]) =>
      run(
        [
          "env",
          `CATALY_CONFIG=${config}`,
          `CATALY_STATE_DIR=${state.dir}`,
          "CATALY_TELEGRAM_TOKEN=123:not-a-real-token",
          "CATALY_TELEGRAM_OWNER_ID=1",
          "CATALY_SLACK_TOKEN=xoxb-not-a-real-token",
          process.execPath,
          cli,
          ...args,
        ],
        { timeoutMs: 10_000 },
      );
    const refused = [
      ["guard", "--loop", "5m"],
      ["freshness", "--loop", "abc"],
      ["freshness", "--loop", "-1"],
      ["guard", "--loop", "Infinity"],
      ["guard", "--loop"],
      ["guard", "--loop", ""],
      ["guard", "--loop", " "],
      ["inbound", "telegram", "--loop", "5m"],
      ["inbound", "slack", "--loop", "abc"],
    ];
    for (const args of refused) {
      const r = await invoke(...args);
      expect({ args, code: r.code, err: r.err, out: r.out }).toEqual({
        args,
        code: 1,
        err: refusedOnWindows(args, "--loop must be a number of minutes, 0 or more"),
        out: "",
      });
    }
    for (const args of [["guard", "--loop", "0"], ["guard"]]) {
      const r = await invoke(...args);
      expect(r.code).toBe(0);
      expect(r.out).toStartWith("HOST_GUARD_READY");
    }
  } finally {
    state.done();
  }
}, 120_000);
