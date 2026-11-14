import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/runtime/exec.ts";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";
import type { RuntimeKind, SessionRef } from "../src/runtime/types.ts";
import { World } from "./fake.ts";
import { terminal } from "./fake-hc.ts";

/** Synthetic extension state and process evidence: no real agent, terminal or ps is started. */
export function ompWorld(kind: RuntimeKind = "herdr", direct = false, withState = true) {
  const stateDir = mkdtempSync(join(tmpdir(), "dori-omp-"));
  const ref: SessionRef = { runtime: kind, id: kind === "herdr" ? "w1:p1" : "t1" };
  const path = join(stateDir, "sessions", `${encodeURIComponent(ref.id)}.json`);
  const record = {
    paneId: ref.id,
    role: "lane",
    sessionId: "omp-session-1",
    sessionFile: "/synthetic/omp-session-1.jsonl",
    cwd: "/w",
    pid: 101,
    startedAt: "2026-11-11T00:00:05Z",
    updatedAt: "2026-11-11T00:00:05Z",
    goal: { status: "active", objective: "finish the assigned task" },
    approvalPending: false,
    agentStatus: undefined as "idle" | "working" | undefined,
  };
  mkdirSync(join(stateDir, "sessions"));
  const save = () => writeFileSync(path, JSON.stringify(record));
  if (withState) save();
  const control = {
    table: `100 1 /bin/bash\n101 ${direct ? 1 : 100} bun /synthetic/omp --dori-role lane\n`,
    started: "2026-11-11T00:00:00Z",
    psCode: 0,
    onPs: (_argv: readonly string[]): void => {},
    onSleep: (): void => {},
  };
  const w = new World();
  const pane = w.addPane("w1:p1", "idle");
  pane.agent = "omp";
  pane.foreground = "omp";
  w.hc.terminals.set(
    "t1",
    terminal({
      pid: direct ? 101 : 100,
      status: { state: "idle", app: "omp" },
      foreground: { name: "bun", argv: ["bun", "/synthetic/omp"], pid: 101 },
    }),
  );
  const psCalls: (readonly string[])[] = [];
  const exec: Exec = async (cmd, argv, options) => {
    if (cmd !== "ps") return w.exec(cmd, argv, options);
    psCalls.push(argv);
    control.onPs(argv);
    return { code: control.psCode, stdout: argv[0] === "-A" ? control.table : control.started, stderr: "" };
  };
  const options = { env: {}, stateDir, sleep: async () => control.onSleep() };
  const rt = kind === "herdr" ? new HerdrRuntime(exec, "", options) : new HcRuntime(exec, options);
  return { w, pane, rt, ref, record, save, path, stateDir, control, psCalls };
}
