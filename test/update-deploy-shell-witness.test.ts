import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { requireShell } from "../src/update/deployment-native.ts";
import { DeploymentHeld, sameProcess } from "../src/update/deployment-process.ts";
import { foregroundFixture } from "./update-deploy-foreground-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

linux.each(["stopped", "owner", "foreground", "nonbare"] as const)(
  "shell rejection retains the actual %s witness without exposing process arguments",
  async (mode) => {
    const f = await foregroundFixture({ rollback: true, paneShell: true });
    const stopped = mode === "stopped" ? f.runtime : f.previousRuntime!;
    expect(sameProcess(f.previousRuntime!)).toBe(false);
    f.front.foreground_processes[0]!.argv.push("private-shell-witness-token");
    if (mode === "foreground") f.writeState({ pid: f.previousRuntime!.pid });
    let failure: unknown;
    try {
      await requireShell(f.config, f.cli, mode === "nonbare" ? undefined : stopped);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeploymentHeld);
    const message = (failure as DeploymentHeld).message;
    const reason = {
      stopped: "native owner changed while awaiting shell (stopped PID is live)",
      owner: "native owner changed while awaiting shell (pane owner is live)",
      foreground: "native owner changed while awaiting shell (foreground PID is live)",
      nonbare: "target pane is not an observed shell",
    }[mode];
    expect(message.startsWith(`${reason}: `)).toBe(true);
    expect(JSON.parse(message.slice(message.indexOf("{")))).toEqual({
      pid: mode === "nonbare" ? null : f.runtime.pid,
      shell: true,
      rootPid: f.front.shell_pid,
      pgid: f.front.foreground_process_group_id,
      pids: f.front.foreground_processes.map(({ pid }) => pid),
      ...(mode === "owner" ? { owner: { pid: f.runtime.pid, sessionId: f.runtime.sessionId, role: "dori" } } : {}),
    });
    expect(message).not.toContain("private-shell-witness-token");
    expect(message).not.toContain(f.runtime.sessionFile);
    expect(message).not.toContain(f.script);
    expect(sameProcess(f.runtime)).toBe(true);
    for (const monitor of f.bootstrap.running!) expect(sameProcess(monitor.identity!)).toBe(true);
    expect(existsSync(f.signalPath)).toBe(false);
  },
);
