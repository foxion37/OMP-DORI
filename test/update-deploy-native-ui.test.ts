import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrDeploymentCli } from "../src/update/deployment-cli.ts";
import { stopRuntime } from "../src/update/deployment-native.ts";
import { DeploymentBusy, DeploymentHeld, sameProcess } from "../src/update/deployment-process.ts";
import { readRestartIntent } from "../src/update/deployment-restart-state.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";
import { managedBashFixture } from "./update-deploy-managed-setup.ts";

const modern = "╭── Native context status ─╮\n╰─                       ─╯\n";
const modernReal = `╭── π > ⬢ model display > 📁 workspace ▶────6%────────╎──────┃─────────128K───╮
╰─                         ⇧⇥ to change thinking effort ─╯
`;
const legacy = " π > ⬢ model display > workspace | idle\n╰─\n";
const linux = test.skipIf(process.platform !== "linux");

linux.each([
  "modern",
  "modern-real",
  "modern-real-draft",
  "legacy",
  "resume",
  "draft",
  "space-draft",
  "unknown",
  "multiline",
  "legacy-working",
  "approval",
  "late-approval",
  "working",
  "late-working",
  "quiesced",
  "session",
  "source",
  "root",
  "foreground",
  "unsupported",
])("opt-in UI stop is idle-only, durable and never falls back to signalling: %s", async (mode) => {
  const f = await managedBashFixture();
  const config = { ...f.config, nativeStopMode: "ui" as const, stopTimeoutMs: mode === "resume" ? 100 : 2_000 };
  const record: DeploymentRecord = {
    ...f.record,
    configHash: digest(JSON.stringify(config)),
    oldRuntime: f.runtime,
    oldMonitors: f.bootstrap.running!.map((entry) => ({ ...entry.identity!, name: entry.name, argv: [] })),
    status: "stopping",
    step: "stop",
  };
  delete record.stopRequestedAt;
  let screen = mode === "legacy" ? legacy : modern;
  if (mode === "modern-real") screen = modernReal;
  if (mode === "modern-real-draft")
    screen = modernReal.replace("╰─                         ", "╰─ draft                   ");
  if (mode === "draft") screen = modern.replace("╰─                       ─╯", "╰─ draft ─╯");
  if (mode === "space-draft") screen = legacy.replace("╰─\n", "╰─ \n");
  if (mode === "unknown") screen = "unknown editor\n>\n";
  if (mode === "multiline") screen = modern.replace("\n╰─", "\n\n╰─");
  if (mode === "legacy-working") screen = " ◐ > ⬢ model display > workspace\n⎋ Working…\n╰─\n";
  if (mode === "approval") f.writeState({ approvalPending: true });
  if (mode === "working" || mode === "quiesced") f.writeState({ agentStatus: "working" });
  if (mode === "quiesced") {
    writeFileSync(
      config.quiesceCheckpointFile,
      JSON.stringify({
        version: 1,
        deploymentId: record.id,
        commit: record.commit,
        sourceHash: record.sourceHash,
        pane: f.runtime.pane,
        sessionId: f.runtime.sessionId,
        pid: f.runtime.pid,
        startTicks: f.runtime.startTicks,
        bootId: f.runtime.bootId,
        startedAt: f.runtime.startedAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      { mode: 0o600 },
    );
  }
  const keys: string[] = [];
  let observations = 0;
  let requestedAt: string | undefined;
  const supported = herdrDeploymentCli(async (cmd, args) => {
    if (cmd === "herdr" && args[3] === "process-info" && ++observations === 2) {
      if (mode === "root") f.front.shell_pid = f.bootstrap.running![0]!.pid;
      if (mode === "foreground") f.front.foreground_process_group_id = undefined;
    }
    if (cmd === "herdr" && args[3] === "read") {
      if (mode === "late-approval") f.writeState({ approvalPending: true });
      if (mode === "late-working") f.writeState({ agentStatus: "working" });
      if (mode === "session") f.writeState({ sessionFile: join(f.root, "different-session.jsonl") });
      if (mode === "source") writeFileSync(join(config.liveSource, "changed.txt"), "changed");
      return { code: 0, stdout: screen, stderr: "" };
    }
    if (cmd === "herdr" && args[3] === "send-keys") {
      expect(args).toEqual(["--session", config.herdrSession!, "pane", "send-keys", config.pane, "ctrl+d"]);
      const saved = readRestartIntent(config)!;
      expect(saved.oldRuntime).toEqual(f.runtime);
      expect(saved.stopRequestedAt).toBeDefined();
      expect(saved.nativeUiExitRequestedAt).toBeDefined();
      requestedAt = saved.nativeUiExitRequestedAt;
      keys.push(args[5]!);
      if (mode !== "resume") f.closeNativeInput();
      return { code: mode === "resume" ? 91 : 0, stdout: "{}", stderr: "" };
    }
    return f.cli.exec(cmd, args);
  }, config.herdrSession!);
  const { nativeUi: _nativeUi, ...withoutUi } = supported;
  const cli = mode === "unsupported" ? withoutUi : supported;
  const stopping = stopRuntime(config, cli, record, f.persist, mode === "quiesced");
  if (mode === "resume") {
    await expect(stopping).rejects.toThrow();
    expect(sameProcess(f.runtime)).toBe(true);
    expect(existsSync(f.signalPath)).toBe(false);
    f.writeState({ approvalPending: true, agentStatus: "working" });
    screen = "unknown editor";
    const saved = readRestartIntent(config)!;
    await expect(stopRuntime(config, cli, saved, f.persist)).rejects.toThrow("native runtime did not stop");
    expect(readRestartIntent(config)!.nativeUiExitRequestedAt).toBe(requestedAt);
    f.closeNativeInput();
    await stopRuntime({ ...config, stopTimeoutMs: 2_000 }, cli, saved, f.persist);
  } else if (mode === "modern" || mode === "modern-real" || mode === "legacy") await stopping;
  else {
    const busy = ["working", "late-working", "quiesced"].includes(mode);
    await expect(stopping).rejects.toThrow(busy ? DeploymentBusy : DeploymentHeld);
    expect(record.stopRequestedAt).toBeUndefined();
    expect(record.nativeUiExitRequestedAt).toBeUndefined();
    expect(sameProcess(f.runtime)).toBe(true);
    for (const monitor of f.bootstrap.running!) expect(sameProcess(monitor.identity!)).toBe(true);
    if (mode === "quiesced") {
      expect(record.quiesceHash).toBeDefined();
      expect(existsSync(config.quiesceCheckpointFile)).toBe(true);
    }
  }
  const exited = mode === "modern" || mode === "modern-real" || mode === "legacy" || mode === "resume";
  expect(keys).toEqual(exited ? ["ctrl+d"] : []);
  expect(existsSync(f.signalPath)).toBe(false);
  if (exited) {
    expect(sameProcess(f.runtime)).toBe(false);
    for (const monitor of f.bootstrap.running!) expect(sameProcess(monitor.identity!)).toBe(false);
    expect(readRestartIntent(config)!.nativeUiExitRequestedAt).toBe(requestedAt);
  }
});
