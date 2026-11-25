import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { withState } from "./fakes.ts";
import { marker } from "./report-race-fixture.ts";

test.each(["done", "halted", "blocker"] as const)(
  "a supervision writer waiting behind %s rechecks terminal state and duplicate blockers",
  async (kind) => {
    const state = withState();
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const release = join(state.dir, "release");
    try {
      const now = Date.now();
      const lane = {
        key: "terminal-race",
        title: "race",
        thread: "none",
        sessionRef: { runtime: "tern" as const, id: "5007" },
        brief: "/b.md",
        done: "file /done.md",
        openedAt: new Date(now - 60_000).toISOString(),
        reportProtocol: "jsonl-v1" as const,
      };
      await new Registry(state.dir).write(lane);
      await new Reports(state.dir).report(lane.key, "milestone", "initial", now);
      const module = (name: string) => JSON.stringify(pathToFileURL(join(import.meta.dir, `../src/${name}.ts`)).href);
      const config = join(state.dir, "config.json");
      writeFileSync(config, JSON.stringify({ stateDir: state.dir, runtime: "tern" }));
      const hook = join(state.dir, "terminal.mjs");
      writeFileSync(
        hook,
        `import { existsSync } from "node:fs";
import { Reports } from ${module("reports")};
const original = Reports.prototype.persist;
Reports.prototype.persist = function(event) {
  console.log("TERMINAL_LOCKED");
  const deadline = Date.now() + 8000;
  const clock = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(${JSON.stringify(release)})) {
    if (Date.now() >= deadline) throw new Error("test barrier was not released");
    Atomics.wait(clock, 0, 0, 10);
  }
  return original.call(this, event);
};
`,
      );
      const resultPath = join(state.dir, "result.json");
      const sweep = join(state.dir, "sweep.mjs");
      writeFileSync(
        sweep,
        `import { writeFileSync } from "node:fs";
import { Registry } from ${module("registry")};
import { Supervision } from ${module("supervision")};
const original = Registry.prototype.read;
Registry.prototype.read = function(...args) {
  console.log("SUPERVISION_WAITING");
  return original.apply(this, args);
};
const delivered = [];
const supervisor = new Supervision({
  registry: new Registry(${JSON.stringify(state.dir)}),
  stateDir: ${JSON.stringify(state.dir)}, clock: { now: () => ${now} },
  run: async () => { throw new Error("unexpected external command"); },
  alert: (_lane, message) => { delivered.push(message); },
}, { defaults: { wallMinutes: 0 } });
const result = await supervisor.sweep(${JSON.stringify(lane)}, "Working 1m");
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ result, delivered }));
`,
      );
      const invoke = (...args: string[]) => {
        const child = Bun.spawn([process.execPath, ...args], {
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
        });
        children.push(child);
        return child;
      };
      const text = kind === "blocker" ? "wallMinutes ceiling reached (0)" : "finished";
      const terminal = invoke(
        "--preload",
        hook,
        join(import.meta.dir, "../src/cli.ts"),
        "report",
        lane.key,
        "--kind",
        kind,
        "--text",
        text,
      );
      const terminalError = new Response(terminal.stderr).text();
      await marker(terminal.stdout, "TERMINAL_LOCKED");
      const observer = invoke(sweep);
      const observerError = new Response(observer.stderr).text();
      await marker(observer.stdout, "SUPERVISION_WAITING");
      writeFileSync(release, "release");
      expect(await terminal.exited).toBe(0);
      expect(await observer.exited).toBe(0);
      expect(await terminalError).toBe("");
      expect(await observerError).toBe("");
      const reports = new Reports(state.dir);
      expect(reports.read(lane.key)?.lastReport).toMatchObject({ kind, text });
      expect(readFileSync(reports.path(lane.key), "utf8").trim().split("\n")).toHaveLength(2);
      const expectedAlerts = kind === "blocker" ? [text] : [];
      const saved = JSON.parse(readFileSync(resultPath, "utf8"));
      expect(saved.result).toMatchObject({ state: kind === "blocker" ? "blocked" : kind, alerts: expectedAlerts });
      expect(saved.delivered).toEqual(expectedAlerts);
      expect(JSON.parse(readFileSync(join(state.dir, "lanes", lane.key, "supervision.json"), "utf8")).alerts).toEqual(
        expectedAlerts,
      );
    } finally {
      writeFileSync(release, "release");
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map((child) => child.exited));
      state.done();
    }
  },
  15_000,
);
