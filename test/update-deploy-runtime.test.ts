import { expect, spyOn, test } from "bun:test";
import { procCmdline } from "../src/update/proc.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PaneState, writePaneState } from "../skills/dori-mode/scripts/src/lane-state.ts";
import { herdrDeploymentCli } from "../src/update/deployment-cli.ts";
import { deploymentConfig } from "./update-deploy-setup.ts";
import { captureRuntime, stopRuntime } from "../src/update/deployment-native.ts";
import { DeploymentBusy, DeploymentHeld, processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord, RuntimeIdentity } from "../src/update/deployment-types.ts";

test
  .skipIf(process.platform !== "linux")
  .each([
    "converges",
    "resumed",
    "stale",
    "live",
    "working",
    "done",
    "done-working",
    "deadline",
    "approval",
    "done-approval",
    "unknown",
    "new-owner",
  ])("native stop observes shell convergence without crossing live boundaries: %s", async (mode) => {
  const root = mkdtempSync(join(tmpdir(), "dori-native-stop-"));
  const config = { ...deploymentConfig(root), omp: join(root, "omp"), stopTimeoutMs: 200 };
  const prompt = spawn("/bin/bash", ["--noprofile", "--norc", "-i"], {
    cwd: root,
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  const promptExited = once(prompt, "exit");
  await once(prompt, "spawn");
  // A real OMP-named entry keeps the child's ps command recognizable to the native writer probe.
  writeFileSync(
    config.omp,
    'process.on("SIGTERM", () => console.log("stopping")); console.log("ready"); await Bun.stdin.text();',
  );
  const argv = [process.execPath, config.omp];
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
  const runtime: RuntimeIdentity = {
    ...processIdentity(child.pid)!,
    role: "dori",
    pane: config.pane,
    sessionId: config.sessionId,
    sessionFile: join(root, "session.jsonl"),
    startedAt: new Date().toISOString(),
    cwd: root,
  };
  const state: PaneState = {
    ...runtime,
    paneId: config.pane,
    updatedAt: runtime.startedAt,
    goal: { status: "none" },
    approvalPending: mode === "approval" || mode === "done-approval",
    agentStatus: mode === "working" || mode === "done-working" ? "working" : "idle",
  };
  writePaneState(config.stateDir, state);
  const record: DeploymentRecord = {
    version: 1,
    id: "native-stop",
    inputHash: "input",
    configHash: "config",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: "c".repeat(64),
    releasePath: join(root, "release"),
    directory: join(root, "transaction"),
    createdAt: new Date().toISOString(),
    status: "stopping",
    step: "stop",
    oldRuntime: runtime,
  };
  if (mode === "resumed") {
    child.stdin.end();
    await child.exited;
  }
  const began = Date.now();
  let clock = began;
  if (mode === "deadline") record.retryDeadlineAt = new Date(began + 1).toISOString();
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const pause = spyOn(Bun, "sleep").mockImplementation(async (ms) => {
    clock += Number(ms);
    if (sameProcess(runtime)) {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("stopping\n");
      child.stdin.end();
      await child.exited;
    }
  });
  let observations = 0;
  let captures = 0;
  let persisted = 0;
  const cli = herdrDeploymentCli(async (cmd, args) => {
    if (cmd !== "herdr") {
      expect(cmd).toBe("ps");
      // Bun tests use a UTC JS clock; make real ps timestamps use that same zone.
      const proc = Bun.spawn([cmd, ...args], {
        env: { ...process.env, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    }
    if (args[3] === "get") {
      if (mode === "deadline" && ++captures === 2) clock++;
      const status = mode.startsWith("done") ? "done" : mode === "unknown" ? "other" : "idle";
      expect(args).toEqual(["--session", "owned-namespace", "pane", "get", config.pane]);
      return {
        code: 0,
        stdout: JSON.stringify({ result: { pane: { agent: "omp", agent_status: status } } }),
        stderr: "",
      };
    }
    expect(args).toEqual(["--session", "owned-namespace", "pane", "process-info", "--pane", config.pane]);
    let processes = [{ pid: child.pid, name: "bun", argv }];
    let rootPid = process.pid;
    if (!sameProcess(runtime)) {
      observations++;
      if (mode === "new-owner") writePaneState(config.stateDir, { ...state, pid: process.pid, approvalPending: true });
      if ((mode !== "stale" && observations >= 3) || mode === "new-owner") {
        rootPid = prompt.pid!;
        processes = [
          {
            pid: rootPid,
            name: "bash",
            argv: procCmdline(rootPid).split("\0").filter(Boolean),
          },
        ];
      } else if (mode === "live") processes = [{ pid: process.pid, name: "omp", argv: ["omp"] }];
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        result: {
          process_info: {
            shell_pid: rootPid,
            foreground_process_group_id: processes[0]!.pid,
            foreground_processes: processes,
          },
        },
      }),
      stderr: "",
    };
  }, "owned-namespace");
  try {
    if (mode === "unknown") await expect(captureRuntime(config, cli, true)).rejects.toThrow(DeploymentHeld);
    else if (mode !== "resumed")
      expect(await captureRuntime(config, cli, true)).toMatchObject({
        ...runtime,
        busy: mode === "working" || mode === "done-working",
        approvalPending: state.approvalPending,
      });
    const busy = mode === "working" || mode === "done-working";
    const stopping = stopRuntime(config, cli, record, () => persisted++, mode === "done-working");
    if (mode === "converges" || mode === "resumed" || mode === "done") {
      await stopping;
      expect(observations).toBe(3);
    } else await expect(stopping).rejects.toThrow(busy ? DeploymentBusy : DeploymentHeld);
    const heldBeforeStop = busy || ["approval", "done-approval", "unknown", "deadline"].includes(mode);
    expect(sameProcess(runtime)).toBe(heldBeforeStop);
    expect(persisted).toBe(heldBeforeStop ? 0 : 1);
    if (heldBeforeStop) expect(record.stopRequestedAt).toBeUndefined();
    if (mode === "live" || mode === "new-owner") expect(observations).toBe(1);
    if (mode === "stale") expect(clock - began).toBe(config.stopTimeoutMs);
  } finally {
    pause.mockRestore();
    now.mockRestore();
    reader.releaseLock();
    if (child.exitCode === null) child.stdin.end();
    await child.exited;
    prompt.stdin!.end();
    await promptExited;
    rmSync(root, { recursive: true, force: true });
  }
});
