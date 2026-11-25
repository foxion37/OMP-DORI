import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { withState } from "./fakes.ts";

import { marker } from "./report-race-fixture.ts";

test.each(["milestone", "done", "blocker"] as const)(
  "a concurrent ordinary %s cannot append between the waiting report's check and append",
  async (kind) => {
    const state = withState();
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const release = join(state.dir, "release");
    try {
      const config = join(state.dir, "config.json");
      const key = "race-lane";
      writeFileSync(config, JSON.stringify({ stateDir: state.dir, runtime: "tern" }));
      await new Registry(state.dir).write({
        key,
        title: "race",
        thread: "none",
        sessionRef: { runtime: "tern", id: "5007" },
        brief: "/b.md",
        done: "file /done.md",
        openedAt: new Date().toISOString(),
        reportProtocol: "jsonl-v1",
      });
      await new Reports(state.dir).report(key, "milestone", "initial", Date.now());
      const module = JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/reports.ts")).href);
      const boundHook = join(state.dir, "bound.mjs");
      // Hold the actual CLI at its second journal read: its latest-report check inside the lane lock.
      writeFileSync(
        boundHook,
        `import { existsSync } from "node:fs";
import { Reports } from ${module};
const original = Reports.prototype.read;
let reads = 0;
Reports.prototype.read = function(key) {
  const result = original.call(this, key);
  if (++reads === 2) {
    console.log("BOUND_CHECKED");
    const deadline = Date.now() + 8000;
    const clock = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(${JSON.stringify(release)})) {
      if (Date.now() >= deadline) throw new Error("test barrier was not released");
      Atomics.wait(clock, 0, 0, 10);
    }
  }
  return result;
};
`,
      );
      const plainHook = join(state.dir, "plain.mjs");
      writeFileSync(
        plainHook,
        `import { Registry } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/registry.ts")).href)};
const original = Registry.prototype.withCurrent;
Registry.prototype.withCurrent = function(...args) {
  console.log("PLAIN_WRITING");
  return original.apply(this, args);
};
`,
      );
      const invoke = (hook: string, ...args: string[]) => {
        const child = Bun.spawn(
          [process.execPath, "--preload", hook, join(import.meta.dir, "../src/cli.ts"), "report", key, ...args],
          {
            env: {
              HOME: state.dir,
              TMPDIR: state.dir,
              PATH: dirname(process.execPath),
              CATALY_CONFIG: config,
              CATALY_STATE_DIR: state.dir,
              CATALY_TELEMETRY: "0",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        children.push(child);
        return child;
      };
      const bound = invoke(
        boundHook,
        "--kind",
        "blocker",
        "--text",
        "older waiting observation",
        "--for",
        "upstream review",
      );
      const boundError = new Response(bound.stderr).text();
      await marker(bound.stdout, "BOUND_CHECKED");
      const plain = invoke(plainHook, "--kind", kind, "--text", "newer ordinary report");
      const plainError = new Response(plain.stderr).text();
      await marker(plain.stdout, "PLAIN_WRITING");
      // Before the fix, this writer finishes while the older writer still holds the compare/append interval.
      const escaped = await Promise.race([plain.exited.then(() => true), Bun.sleep(200).then(() => false)]);
      expect(escaped).toBe(false);
      writeFileSync(release, "release");
      expect(await bound.exited).toBe(0);
      expect(await plain.exited).toBe(0);
      expect(await boundError).toBe("");
      expect(await plainError).toBe("");
      const latest = new Reports(state.dir).read(key)?.lastReport;
      expect(latest).toMatchObject({ kind, text: "newer ordinary report" });
      expect(latest).not.toHaveProperty("wait");
    } finally {
      writeFileSync(release, "release");
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map((child) => child.exited));
      state.done();
    }
  },
  15_000,
);
