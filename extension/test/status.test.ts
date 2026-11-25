import { expect, test } from "bun:test";
import { readPaneState, writePaneState } from "../../skills/cataly-mode/scripts/src/lane-state";
import { load, useConfig } from "./fake-pi";

test.each(["absent", "retired", "live-owner", "replaced"] as const)(
  "Tern pane status writes respect %s pane ownership",
  async (record) => {
    const stateDir = useConfig();
    const previousPane = process.env.TERN_PANE;
    process.env.TERN_PANE = "5007";
    const owner =
      record === "live-owner" || record === "replaced"
        ? Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
        : undefined;
    const saved = {
      paneId: "5007",
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
    const plain = await load({
      session: { id: "plain-tui", entries: [] },
      mode: "tui",
      ...(record === "replaced" ? { flags: { "cataly-role": "lane" } } : {}),
    });
    try {
      if (record === "replaced") {
        await plain.emit("session_start");
        writePaneState(stateDir, saved);
        await plain.emit("session_shutdown");
      } else {
        for (const type of ["session_start", "session_switch", "session_branch", "session_tree"])
          await plain.emit(type);
      }
      expect(readPaneState(stateDir, "5007")).toEqual(owner ? saved : null);
    } finally {
      await plain.emit("session_shutdown");
      if (owner) {
        owner.kill();
        await owner.exited;
      }
      if (previousPane === undefined) delete process.env.TERN_PANE;
      else process.env.TERN_PANE = previousPane;
    }
  },
);
