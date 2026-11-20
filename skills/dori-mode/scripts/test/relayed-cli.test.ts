import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshnessTick } from "../src/freshness.ts";
import { Reports, reportId } from "../src/reports.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("report --owner --json and relayed bind the exact report across CLI processes", async () => {
  const state = withState();
  try {
    const world = newWorld();
    world.screen = "Working (1m)";
    const now = Date.now();
    const clock = fakeClock(now + 60 * 60_000);
    const deps = depsFor(world, clock, state.dir, {
      freshness: { nudge: "idle-only", postRaw: false },
      hooks: { threadReply: ["notify", "{text}"] },
    });
    await deps.registry.write({
      key: "relay-lane",
      title: "relay",
      thread: "discord:123",
      pane: "w:p7",
      brief: "/b",
      done: "file /done",
      openedAt: new Date(now - 60_000).toISOString(),
      reportProtocol: "jsonl-v1",
      lastReplyAt: now - 60_000,
      lastNudgeAt: now,
    });
    const config = join(state.dir, "config.json");
    await Bun.write(config, JSON.stringify({ stateDir: state.dir }));
    const invoke = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        env: {
          HOME: state.dir,
          PATH: process.env["PATH"] ?? process.env["Path"],
          DORI_CONFIG: config,
          ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"], USERPROFILE: state.dir } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, out: out.trim(), err: err.trim() };
    };
    const reported = await invoke(
      "report",
      "relay-lane",
      "--kind",
      "milestone",
      "--text",
      "lead detail",
      "--owner",
      "Ready for review",
      "--json",
    );
    expect(reported.code).toBe(0);
    const receipt = JSON.parse(reported.out);
    expect(receipt.owner).toBe("Ready for review");
    expect(receipt.id).toMatch(/^[a-f0-9]{64}$/);
    const reports = new Reports(state.dir);
    const entry = reports.read("relay-lane")?.lastReport;
    expect(entry).not.toBeNull();
    expect(entry && reportId(entry)).toBe(receipt.id);
    const relayed = await invoke("relayed", "relay-lane", "--report", receipt.id);
    expect({ code: relayed.code, out: relayed.out.trim() }).toEqual({
      code: 0,
      out: `RELAYED relay-lane ${receipt.id}`,
    });
    const acknowledged = await deps.registry.read("relay-lane");
    expect(acknowledged?.lastPostedReportId).toBe(receipt.id);
    expect(acknowledged?.lastReplyAt).toBe(now - 60_000);
    expect(acknowledged?.lastNudgeAt).toBe(now);
    expect(acknowledged?.lastRelayedAt).toBeGreaterThanOrEqual(now);
    await freshnessTick(deps, state.dir);
    expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
    // Same millisecond and lead text, different summary: the old receipt must not acknowledge the new report.
    const newer = reports.report(
      "relay-lane",
      "milestone",
      entry?.text ?? "",
      Date.parse(receipt.at),
      undefined,
      "Now ready to ship",
    );
    expect(reportId(newer)).not.toBe(receipt.id);
    const rejected = await invoke("relayed", "relay-lane", "--report", receipt.id);
    expect(rejected.code).not.toBe(0);
    expect(rejected.err).toContain("not the current journal report");
    expect((await deps.registry.read("relay-lane"))?.lastPostedReportId).toBe(receipt.id);
    await freshnessTick(deps, state.dir);
    expect(world.calls.find((c) => c[0] === "notify")?.[1]).toContain("Now ready to ship");
    const missing = await invoke("relayed", "relay-lane");
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain("--report");

    if (!acknowledged) throw new Error("lane acknowledgement missing");
    const reopened = await deps.registry.transition(acknowledged, (current) => ({
      ...current,
      lifecycleEpoch: "replacement",
    }));
    expect(reopened?.lifecycleEpoch).toBe("replacement");
    const late = await invoke("relayed", "relay-lane", "--report", reportId(newer));
    expect(late.code).not.toBe(0);
    expect(late.err).toContain("not the current journal report");
    const replacement = reports.report(
      newer.key,
      newer.kind,
      newer.text,
      Date.parse(newer.at),
      "replacement",
      newer.owner,
    );
    expect(reportId(replacement)).not.toBe(reportId(newer));
    const exact = await invoke("relayed", "relay-lane", "--report", reportId(replacement));
    expect(exact.out.trim()).toBe(`RELAYED relay-lane ${reportId(replacement)}`);
    expect((await deps.registry.read("relay-lane"))?.lastPostedReportId).toBe(reportId(replacement));
  } finally {
    state.done();
  }
});
