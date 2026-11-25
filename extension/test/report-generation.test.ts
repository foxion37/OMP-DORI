import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Checkpoints } from "../../skills/cataly-mode/scripts/src/checkpoints.ts";
import { evidenceClock, fileEvidence } from "../../skills/cataly-mode/scripts/src/evidence.ts";
import { recordExecution } from "../../skills/cataly-mode/scripts/src/lane-run.ts";
import { type Lane, Registry } from "../../skills/cataly-mode/scripts/src/registry.ts";
import { Reports, reportScope } from "../../skills/cataly-mode/scripts/src/reports.ts";
import { type FakePi, type FakeSession, load, useConfig } from "./fake-pi";

const HEADLESS = "00000000-0000-4000-8000-000000000005";
const native = { mode: "rpc", hasUI: true } as const;

test("cataly_report scopes reopened evidence while sharing the journal acceptance sequence", async () => {
  const names = ["CATALY_CONFIG", "CATALY_STATE_DIR", "CATALY_HEADLESS_ID"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let pi: FakePi | undefined;
  try {
    const stateDir = useConfig();
    const key = "generation-evidence";
    const generation = randomUUID();
    const oldGeneration = randomUUID();
    process.env.CATALY_HEADLESS_ID = HEADLESS;
    const registry = new Registry(stateDir);
    const priorLane = {
      key,
      title: "reopened evidence",
      thread: "none",
      sessionRef: { runtime: "headless", id: HEADLESS },
      brief: "/brief.md",
      done: "file /done.md",
      openedAt: "2026-01-01T00:00:00.000Z",
      lifecycleEpoch: oldGeneration,
      reportProtocol: "jsonl-v1",
    } satisfies Lane;
    await registry.write(priorLane);
    const source = join(dirname(stateDir), "result.txt");
    writeFileSync(source, "unchanged across reopen");
    const refs = [fileEvidence(source, stateDir)];
    const reports = new Reports(stateDir);
    const old = await registry.withCurrent(key, (current) => {
      if (!current || current.lifecycleEpoch !== oldGeneration)
        throw new Error("old lane generation is not registered");
      return reports.report(
        key,
        "done",
        "old generation finished",
        Date.parse(current.openedAt),
        current.lifecycleEpoch,
        undefined,
        undefined,
        refs,
      );
    });
    await registry.write({ ...priorLane, openedAt: "2026-01-02T00:00:00.000Z", lifecycleEpoch: generation });
    pi = await load({
      session: { id: "generation-session", entries: [] },
      flags: { "cataly-role": "lane" },
      ...native,
    });
    await pi.emit("session_start");
    const tool = pi.tools.get("cataly_report");
    if (!tool) throw new Error("cataly_report is not registered");
    const params = { kind: "milestone", text: "new generation report", files: [source] };
    const first = await tool.execute("first-report", params, undefined, undefined, pi.ctx());
    expect(first.content.map((block) => block.text).join("\n")).toEndWith(
      "1 of 1 evidence items are new; the evidence clock moved",
    );
    const current = reports.read(key, { generation });
    expect(current?.lastReport).toMatchObject({ generation, evidenceRefs: refs, evidenceSequence: 2 });
    expect(reports.read(key, { generation: oldGeneration })?.lastReport).toEqual(old);
    const clock = evidenceClock(current?.evidenced ?? []);
    const again = await tool.execute("second-report", params, undefined, undefined, pi.ctx());
    expect(again.content.map((block) => block.text).join("\n")).toEndWith(
      "the same evidence was recorded before; the evidence clock did not move",
    );
    expect(evidenceClock(reports.read(key, { generation })?.evidenced ?? [])).toEqual(clock);
    expect(reports.read(key)?.evidenced.map((entry) => entry.evidenceSequence)).toEqual([1, 2, 3]);
  } finally {
    await pi?.emit("session_shutdown");
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("cataly_report accepts only the verified native run and scopes both journals to it", async () => {
  const names = ["CATALY_CONFIG", "CATALY_STATE_DIR", "CATALY_HEADLESS_ID", "CATALY_LANE_RUN"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let pi: FakePi | undefined;
  try {
    const stateDir = useConfig();
    const key = "verified-evidence";
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    const session: FakeSession = {
      id: "verified-session",
      entries: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "retained-read", name: "read", arguments: { path: "result.txt" } }],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "retained-read",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: "earlier result retained on the native branch" }],
          },
        },
      ],
    };
    const lane = {
      key,
      title: "verified evidence",
      thread: "none",
      sessionRef: { runtime: "headless", id: HEADLESS },
      session: session.id,
      brief: "/brief.md",
      done: "file /done.md",
      openedAt: new Date(now).toISOString(),
      lifecycleEpoch: randomUUID(),
      requestId: "telegram:-123:456",
      runId: randomUUID(),
      reportProtocol: "jsonl-v1",
    } satisfies Lane;
    const oldRun = { ...lane, runId: randomUUID() };
    const oldRef = { requestId: lane.requestId, runId: oldRun.runId };
    const currentRef = {
      requestId: lane.requestId,
      runId: lane.runId,
      nativeRef: { sessionId: session.id, ref: { runtime: "headless" as const, id: HEADLESS } },
    };
    process.env.CATALY_HEADLESS_ID = HEADLESS;
    process.env.CATALY_LANE_RUN = lane.runId;
    const registry = new Registry(stateDir);
    await registry.write(oldRun);
    const oldSource = join(dirname(stateDir), "old-run.txt");
    const currentSource = join(dirname(stateDir), "current-run.txt");
    writeFileSync(oldSource, "previous run's evidence");
    writeFileSync(currentSource, "this run's checkpoint evidence");
    const oldEvidence = fileEvidence(oldSource, stateDir);
    const currentEvidence = fileEvidence(currentSource, stateDir);
    const reports = new Reports(stateDir);
    await registry.withCurrent(key, (current) => {
      if (!current || current.runId !== oldRun.runId) throw new Error("old execution is not registered");
      recordExecution(stateDir, current, now);
      reports.report(key, "done", "previous run", now, current.lifecycleEpoch, undefined, oldRef, [oldEvidence]);
    });
    const checkpoints = new Checkpoints(stateDir);
    await checkpoints.write(
      key,
      { step: "old-run", result: "done", evidence: [], remoteEffects: [], evidenceRefs: [oldEvidence] },
      now,
      undefined,
      oldRef,
    );
    await registry.write(lane);
    await registry.withCurrent(key, (current) => {
      if (!current || current.runId !== lane.runId) throw new Error("current execution is not registered");
      recordExecution(stateDir, current, now);
    });
    const root = await load({ session, flags: { "cataly-role": "lane" }, ...native });
    pi = root;
    await root.emit("session_start");
    const tool = root.tools.get("cataly_report");
    if (!tool) throw new Error("cataly_report is not registered");
    const params = { kind: "milestone", text: "current run", files: [oldSource, currentSource] };
    const invoke = () => tool.execute("verified-report", params, undefined, undefined, root.ctx());
    await expect(invoke()).rejects.toThrow("requires the registered execution's verified native session");
    expect(reports.read(key, reportScope(lane))).toBeNull();
    await registry.withCurrent(key, (current) => {
      if (!current || current.runId !== lane.runId) throw new Error("current execution changed before native readback");
      recordExecution(stateDir, current, now, session.id);
    });
    await expect(
      tool.execute("retained-evidence", { ...params, toolCalls: ["retained-read"] }, undefined, undefined, root.ctx()),
    ).rejects.toThrow("this execution did not observe its start");
    expect(reports.read(key, reportScope(lane))).toBeNull();
    await checkpoints.write(
      key,
      { step: "current-run", result: "done", evidence: [], remoteEffects: [], evidenceRefs: [currentEvidence] },
      now,
      undefined,
      currentRef,
    );
    const out = await invoke();
    expect(out.content.map((block) => block.text).join("\n")).toEndWith(
      "1 of 2 evidence items are new; the evidence clock moved",
    );
    const current = reports.read(key, reportScope(lane));
    expect(current?.lastReport).toMatchObject({ provenance: currentRef, evidenceRefs: [oldEvidence, currentEvidence] });
    expect(current?.evidenced).toHaveLength(1);
    expect(reports.read(key, reportScope(oldRun))?.lastReport?.text).toBe("previous run");
    root.session = { id: "unbound-sibling", entries: [] };
    await root.emit("session_switch", { reason: "new" });
    await expect(invoke()).rejects.toThrow("lane registration belongs to another native session");
    expect(reports.read(key, reportScope(lane))?.lastReport).toEqual(current?.lastReport);
  } finally {
    await pi?.emit("session_shutdown");
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
