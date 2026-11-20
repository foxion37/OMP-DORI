import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { readPaneState, writePaneState } from "../../skills/dori-mode/scripts/src/lane-state";
import { load, useConfig } from "./fake-pi";

test("HC receives native role-session status, approval holds and role-removal invalidation", async () => {
  const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  const previousPane = process.env.HERDR_PANE_ID;
  const previousTerminal = process.env.HC_TERMINAL_ID;
  process.env.HERDR_PANE_ID = "w1:p8";
  process.env.HC_TERMINAL_ID = "t7";
  const frames: string[] = [];
  const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string") frames.push(chunk);
    return true;
  });
  const pi = await load({ session: { id: "hc-status", entries: [] }, flags: { "dori-role": "lane" } });
  try {
    await pi.emit("session_start");
    expect(frames).toEqual(["\x1b]7501;state=idle:app=omp\x1b\\"]);
    await pi.emit("agent_start");
    expect(frames.at(-1)).toBe("\x1b]7501;state=working:app=omp\x1b\\");
    expect(readPaneState(stateDir, "t7")?.agentStatus).toBe("working");
    await pi.emit("tool_approval_requested", { toolCallId: "approval" });
    expect(frames.at(-1)).toBe("\x1b]7501;state=blocked:app=omp\x1b\\");
    await pi.emit("agent_end");
    expect(frames.at(-1)).toBe("\x1b]7501;state=blocked:app=omp\x1b\\");
    expect(readPaneState(stateDir, "t7")).toMatchObject({ agentStatus: "idle", approvalPending: true });
    await pi.emit("tool_approval_resolved", { toolCallId: "approval" });
    expect(frames.at(-1)).toBe("\x1b]7501;state=idle:app=omp\x1b\\");
    pi.session = { id: "plain", entries: [] };
    await pi.emit("session_switch");
    expect(frames.at(-1)).toBe("\x1b]7501;state=unknown:app=omp\x1b\\");
    expect(readPaneState(stateDir, "t7")).toBeNull();
    const recorded = frames.length;
    await pi.emit("agent_start");
    expect(frames.length).toBe(recorded);
  } finally {
    await pi.emit("session_shutdown");
    output.mockRestore();
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
    if (previousTerminal === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = previousTerminal;
  }
});

test.each(["absent", "retired", "live-owner", "replaced"] as const)(
  "HC status writes respect %s pane ownership",
  async (record) => {
    const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
    const previousTerminal = process.env.HC_TERMINAL_ID;
    process.env.HC_TERMINAL_ID = "t7";
    const owner =
      record === "live-owner" || record === "replaced"
        ? Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
        : undefined;
    const saved = {
      paneId: "t7",
      role: "lane" as const,
      sessionId: "previous",
      sessionFile: "/sessions/previous.jsonl",
      cwd: "/tmp",
      pid: owner?.pid ?? 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      goal: { status: "none" as const },
      approvalPending: false,
    };
    if (record !== "absent" && record !== "replaced") writePaneState(stateDir, saved);
    const frames: string[] = [];
    const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (typeof chunk === "string") frames.push(chunk);
      return true;
    });
    const plain = await load({
      session: { id: "plain-tui", entries: [] },
      mode: "tui",
      ...(record === "replaced" ? { flags: { "dori-role": "lane" } } : {}),
    });
    try {
      if (record === "replaced") {
        await plain.emit("session_start");
        writePaneState(stateDir, saved);
        frames.length = 0;
        await plain.emit("session_shutdown");
      } else {
        for (const type of ["session_start", "session_switch", "session_branch", "session_tree"])
          await plain.emit(type);
      }
      expect(frames).toEqual([]);
      expect(readPaneState(stateDir, "t7")).toEqual(owner ? saved : null);
    } finally {
      await plain.emit("session_shutdown");
      output.mockRestore();
      if (owner) {
        owner.kill();
        await owner.exited;
      }
      if (previousTerminal === undefined) delete process.env.HC_TERMINAL_ID;
      else process.env.HC_TERMINAL_ID = previousTerminal;
    }
  },
);
