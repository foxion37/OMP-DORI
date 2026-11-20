import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitors } from "../monitor.ts";
import { until } from "./fake-pi.ts";

const cmd = (script: string) => [process.execPath, "-e", script];

test("a crashing monitor is restarted only with explicit policy and stops after three retries", async () => {
  const lines: string[] = [];
  const monitors = new Monitors(
    (text) => lines.push(text),
    () => "owner",
    5,
    30,
  );
  try {
    const argv = cmd('console.log("fixture-start", process.pid); process.exit(7)');
    monitors.start("receiver", argv, "^fixture-start", process.cwd(), "owner", "on-failure");
    monitors.start("ordinary", argv, "^fixture-start", process.cwd(), "owner");
    monitors.start(
      "oneshot",
      cmd('console.log("fixture-start", process.pid)'),
      "^fixture-start",
      process.cwd(),
      "owner",
      "on-failure",
    );
    await until(() => lines.join("\n").includes("[receiver] monitor exited (code 7)"));
    const delivered = lines.join("\n").split("\n");
    const receiver = delivered.filter((line) => line.startsWith("[receiver] fixture-start "));
    expect(receiver).toHaveLength(4);
    expect(new Set(receiver).size).toBe(4);
    expect(delivered.filter((line) => line.startsWith("[ordinary] fixture-start "))).toHaveLength(1);
    expect(delivered.filter((line) => line.startsWith("[oneshot] fixture-start "))).toHaveLength(1);
    expect(monitors.specs()).toEqual([]);
  } finally {
    monitors.stopAll();
  }
});

for (const ending of ["stop", "shutdown", "session switch"] as const) {
  test(`${ending} prevents a scheduled receiver from starting in the wrong session`, async () => {
    let session = "owner";
    const lines: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "cataly-monitor-restart-"));
    const runs = join(root, "runs");
    const monitors = new Monitors(
      (text) => lines.push(text),
      () => session,
      5,
      250,
    );
    try {
      const argv = cmd(
        `require("node:fs").appendFileSync(${JSON.stringify(runs)}, "start\\n"); console.log("fixture-start"); process.exit(3)`,
      );
      monitors.start("receiver", argv, "^fixture-start", process.cwd(), "owner", "on-failure");
      await until(() => lines.length === 1 && monitors.list().length === 0 && monitors.specs().length === 1);
      expect(() => monitors.start("receiver", argv, "^fixture-start", process.cwd(), "owner")).toThrow(
        "already running",
      );
      if (ending === "stop") expect(monitors.stop("receiver")).toBe(true);
      else if (ending === "shutdown") monitors.stopAll();
      else session = "other";
      // The real subprocess has already exited; let its actual restart deadline pass.
      await Bun.sleep(300);
      expect(lines).toEqual(["[receiver] fixture-start"]);
      expect(readFileSync(runs, "utf8")).toBe("start\n");
      expect(monitors.specs()).toEqual([]);
    } finally {
      monitors.stopAll();
      rmSync(root, { recursive: true });
    }
  });
}

test("delivery failure after an opted-in child exits does not start a replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-monitor-delivery-"));
  const runs = join(root, "runs");
  const started = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<void>();
  const monitors = new Monitors(
    (text) => {
      if (!text.includes("fixture-start")) return;
      started.resolve();
      return delivery.promise;
    },
    () => "owner",
    5,
    20,
  );
  try {
    const argv = cmd(
      `require("node:fs").appendFileSync(${JSON.stringify(runs)}, "start\\n"); console.log("fixture-start"); process.exit(3)`,
    );
    monitors.start("receiver", argv, "^fixture-start", process.cwd(), "owner", "on-failure");
    await started.promise;
    // Keep delivery unresolved past the real retry delay to exercise the process/delivery race.
    await Bun.sleep(60);
    delivery.reject(new Error("fixture delivery error"));
    await until(() => monitors.specs().length === 0);
    expect(readFileSync(runs, "utf8")).toBe("start\n");
  } finally {
    delivery.resolve();
    monitors.stopAll();
    rmSync(root, { recursive: true });
  }
});
