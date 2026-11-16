import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { hhmm } from "../src/fit.ts";
import { ready, startLane } from "../src/lanes.ts";
import { audit } from "../src/loop-audit.ts";
import { spawnExec, type Exec } from "../src/runtime/exec.ts";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { laneBoard } from "../src/status-view.ts";
import type { LoopRun } from "../src/store-types.ts";
import { href } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const MIN = 60_000;
const MODES = ["agent prompt", "typed fallback"] as const;
const EVIDENCE_CASES = MODES.flatMap((mode) => [" ", "  "].map((spaces) => [mode, spaces] as const));

// Use a real child process for every herdr call, including the failed prompt and subsequent typed fallback.
async function referenceLane(mode: (typeof MODES)[number]) {
  const s = setup();
  const lane = await startLane(s.d, "references", s.brief, { group: "w1" });
  const log = join(s.d.store.root, "herdr-calls.jsonl");
  const failures = join(s.d.store.root, "enter-failures");
  const script = join(s.d.store.root, "fake-herdr.ts");
  writeFileSync(log, "");
  writeFileSync(failures, "0");
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const [group, verb, id] = args;
const ok = (result) => console.log(JSON.stringify({ result }));
if (group === "agent" && verb === "prompt") {
  if (${mode === "typed fallback"}) {
    process.stderr.write('{"error":{"code":"agent_not_ready"}}');
    process.exit(1);
  }
  ok({});
} else if (group === "pane" && verb === "get") {
  ok({ pane: { pane_id: id, agent: "pi", agent_status: "idle" } });
} else if (group === "pane" && verb === "process-info") {
  ok({ process_info: { foreground_process_group_id: 101, foreground_processes: [{ name: "omo", argv: ["omo"] }] } });
} else if (group === "pane" && verb === "send-keys" && args[3] === "enter") {
  const left = Number(readFileSync(${JSON.stringify(failures)}, "utf8"));
  if (left > 0) {
    writeFileSync(${JSON.stringify(failures)}, String(left - 1));
    process.stderr.write("fixture Enter failed");
    process.exit(1);
  }
  ok({});
} else if (group === "pane" && verb === "send-text") {
  ok({});
} else {
  process.stderr.write("unexpected fake herdr call: " + JSON.stringify(args));
  process.exit(1);
}
`,
  );
  const exec: Exec = (cmd, argv, options) => {
    expect(cmd).toBe("herdr");
    return spawnExec(process.execPath, [script, ...argv], options);
  };
  const sleeps: number[] = [];
  const runtime = new HerdrRuntime(exec, "", { env: {}, sleep: async (ms) => void sleeps.push(ms) });
  const d = { ...s.d, exec, runtimes: new Runtimes("herdr", () => runtime) };
  const calls = (): string[][] =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const received = (pane = "w1:p1") =>
    calls()
      .filter((a) => a[2] === pane && (mode === "agent prompt" ? a[0] === "agent" : a[1] === "send-text"))
      .map((a) => a[3]!);
  return { ...s, d, lane, calls, received, failures, sleeps };
}

describe("full references through the herdr consumer", () => {
  test.each(EVIDENCE_CASES)("full evidence path via %s (separator %s)", async (mode, spaces) => {
    const s = await referenceLane(mode);
    try {
      const file = join(s.d.store.root, `${`\uC99D\uAC70${spaces}build `.repeat(10)}e\u0301.md`);
      expect(Bun.stringWidth(file)).toBeGreaterThan(120);
      writeFileSync(file, "proof");
      s.w.clock += MIN;
      utimesSync(file, s.w.clock / 1000, s.w.clock / 1000);
      const progress = s.w.clock;
      const args = ["report", "references", "--text", "new", "--evidence", file];
      const moved = await captureIo(() => main(args, s.d));
      expect(moved.code).toBe(0);
      expect(s.d.store.lane("references")).toMatchObject({ progressAt: progress, lastEvidence: { ref: file } });
      s.w.clock += MIN;
      const skipped = await captureIo(() => main(args, s.d));
      expect(skipped.code).toBe(0);
      expect(s.d.store.lane("references")!.progressAt).toBe(progress);
      s.w.clock = progress + 40 * MIN;
      expect(await dutyTick(s.d)).toContainEqual({ lane: "references", action: "escalated" });
      const escalated = s.d.store.lane("references")!.log.at(-1)!.text;
      expect(await ready(s.d, "references", "done", [file])).toBe("DELIVERED");
      const messages = s.received();
      expect(messages).toHaveLength(4);
      for (const message of messages) expect(message).toContain(file);
      expect(messages[0]).toContain(`evidence: ${file}`);
      expect(messages[3]).toContain(`evidence: ${file}`);
      expect(moved.out.split("\n").slice(2)).toEqual([`  ${file}`]);
      expect(skipped.out.split("\n")[2]).toContain("(not changed since ");
      expect(skipped.out.split("\n").slice(3)).toEqual([`  ${file}`]);
      expect(escalated.split("\n").slice(3)).toEqual([`  ${file}`]);
      expect(s.calls().filter((a) => a[0] === "agent")).toHaveLength(4);
      expect(s.calls().filter((a) => a[1] === "send-text")).toHaveLength(mode === "typed fallback" ? 4 : 0);
      expect(s.calls().filter((a) => a[1] === "send-keys")).toHaveLength(mode === "typed fallback" ? 4 : 0);
      expect(s.sleeps).toEqual(mode === "typed fallback" ? [400, 400, 400, 400] : []);
      expect(s.d.store.queued(href("w1:p1"))).toEqual([]);
    } finally {
      rmSync(s.d.store.root, { recursive: true });
    }
  });

  test.each(MODES)("full waiting target via %s before and after an upgrade", async (mode) => {
    for (const legacy of [false, true]) {
      const s = await referenceLane(mode);
      const previous = process.env["DORI_PROMPTS_DIR"];
      try {
        const target = join(s.d.store.root, `${"\uB300\uAE30  deploy ".repeat(10)}receipt.json`);
        expect(Bun.stringWidth(target)).toBeGreaterThan(120);
        const args = [
          "report",
          "references",
          "--status",
          "waiting",
          ...(legacy ? [] : ["--for", target]),
          "--text",
          legacy ? `WAITING: ${target}` : "WAITING: receipt",
        ];
        expect((await captureIo(() => main(args, s.d))).code).toBe(0);
        if (legacy) {
          const old = s.d.store.lane("references")!;
          delete old.waitingFor;
          delete old.waitingSince;
          s.d.store.saveLane(old);
        }
        expect((await captureIo(() => main(["report", "references", "--text", "still waiting"], s.d))).code).toBe(0);
        expect(s.d.store.lane("references")).toMatchObject({ waitingFor: target, waitingSince: s.lane.createdAt });
        if (legacy) {
          const dir = join(s.d.store.root, "old-prompts");
          mkdirSync(dir);
          writeFileSync(join(dir, "nudge-waiting.md"), "[custom {{key}}] Waiting on {{target}} since {{waitingSince}}");
          process.env["DORI_PROMPTS_DIR"] = dir;
        }
        s.w.clock = s.lane.createdAt + 10 * MIN;
        expect(await dutyTick(s.d)).toContainEqual({ lane: "references", action: "nudge-1" });
        const nudge = s.calls().find((a) => a[0] === "agent" && a[2] === s.lane.paneId)![3]!;
        expect(nudge.split("\n").filter((line) => line.startsWith("  "))).toEqual([`  ${target}`]);
        expect(Bun.stringWidth(nudge.split("\n")[0]!)).toBeLessThanOrEqual(120);
        expect(s.received(s.lane.paneId)).toHaveLength(1);
        expect(s.received(s.lane.paneId)[0]).toContain(target);
        expect(laneBoard(s.d.store.lanes(), s.w.clock)).toContain(`  ${target}`);
        s.w.clock = s.lane.createdAt + 40 * MIN;
        expect(await dutyTick(s.d)).toContainEqual({ lane: "references", action: "escalated" });
        expect(s.received().at(-1)).toContain(target);
        expect(s.d.store.lane("references")!.log.at(-1)!.text.split("\n")[2]).toBe(`  ${target}`);
        expect(await dutyTick(s.d)).toEqual([]);
        expect(s.received()).toHaveLength(3);
        expect(s.d.store.queued(s.lane.sessionRef)).toEqual([]);
        s.w.clock = s.lane.createdAt + 4 * 60 * MIN;
        const run: LoopRun = { at: s.w.clock, synced: [], findings: [], started: [], held: [], asked: [] };
        await audit(s.d, run);
        expect(run.findings).toEqual([
          `references waiting, no progress for 4h: on ${target} since ${hhmm(s.lane.createdAt)}`,
        ]);
        expect(s.calls().filter((a) => a[1] === "send-text")).toHaveLength(mode === "typed fallback" ? 4 : 0);
      } finally {
        if (previous === undefined) delete process.env["DORI_PROMPTS_DIR"];
        else process.env["DORI_PROMPTS_DIR"] = previous;
        rmSync(s.d.store.root, { recursive: true });
      }
    }
  });

  test("a failed fallback Enter retains the exact target and queued identity, then submits without retyping", async () => {
    const s = await referenceLane("typed fallback");
    try {
      const target = join(s.d.store.root, `${"\uB300\uAE30  deploy ".repeat(10)}receipt.json`);
      const args = ["report", "references", "--status", "waiting", "--for", target, "--text", "WAITING: receipt"];
      expect((await captureIo(() => main(args, s.d))).code).toBe(0);
      writeFileSync(s.failures, "3");
      s.w.clock = s.lane.createdAt + 10 * MIN;
      const events = await dutyTick(s.d);
      expect(events).toContainEqual({ lane: "references", action: "nudge-1" });
      expect(events).toContainEqual({ lane: "references", action: "lane-failed", detail: "fixture Enter failed" });
      const [queued] = s.d.store.queued(s.lane.sessionRef);
      expect(queued).toMatchObject({ attempt: { state: "typed", agent: "pi", pgid: 101 } });
      const lane = s.d.store.lane("references")!;
      expect(queued!.id).toBe(`nudge:references:${lane.noticeId}:${lane.progressEpoch}:1`);
      expect(queued!.text.split("\n")).toContain(`  ${target}`);
      expect(s.received(s.lane.paneId)).toHaveLength(1);
      expect(s.received(s.lane.paneId)[0]).toContain(target);
      const sent = s.calls().length;
      s.w.clock += MIN;
      expect(await dutyTick(s.d)).toEqual([{ pane: s.lane.paneId, action: "flushed" }]);
      expect(s.d.store.queued(s.lane.sessionRef)).toEqual([]);
      expect(
        s
          .calls()
          .slice(sent)
          .filter((a) => a[0] === "agent" || a[1] === "send-text"),
      ).toEqual([]);
      expect(s.calls().filter((a) => a[1] === "send-keys" && a[2] === s.lane.paneId)).toHaveLength(4);
      expect(s.d.store.lane("references")).toMatchObject({
        nudges: 1,
        progressAt: s.lane.createdAt,
        waitingSince: s.lane.createdAt,
        waitingFor: target,
      });
      expect(s.received()).toHaveLength(1);
    } finally {
      rmSync(s.d.store.root, { recursive: true });
    }
  });
});
