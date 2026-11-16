import { expect, test } from "bun:test";
import { procChildren, procCmdline } from "../src/update/proc.ts";
import { once } from "node:events";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LaunchedProcessHeld, launchedProcess, launchRuntime } from "../src/update/deployment-launch.ts";
import { nativeCli, requireShell } from "../src/update/deployment-native.ts";
import { DeploymentHeld, processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import { rollbackDeployment, waitLaunchedProcess } from "../src/update/deployment-rollback.ts";
import { managedBashFixture } from "./update-deploy-managed-setup.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

posix.each(["forward", "rollback"] as const)(
  "a present unattested %s launch holds instead of becoming an absent launch or a pane-run",
  async (direction) => {
    const f = await managedBashFixture({ unknown: true });
    f.record.step = "rollback";
    f.record.rollbackRequestedAt = f.launchRequestedAt;
    if (direction === "rollback") f.record.rollbackLaunchRequestedAt = f.launchRequestedAt;
    f.persist(f.record);
    const prior = direction === "rollback";
    const cli = nativeCli(f.config);
    await expect(launchedProcess(f.config, cli, f.record, f.launchRequestedAt, prior)).rejects.toThrow(
      LaunchedProcessHeld,
    );
    await expect(waitLaunchedProcess(f.config, f.record, f.launchRequestedAt, prior)).rejects.toThrow(
      LaunchedProcessHeld,
    );
    await expect(rollbackDeployment(f.config, f.record, f.persist)).rejects.toThrow(LaunchedProcessHeld);
    await expect(launchRuntime(f.config, cli, f.record, false, prior)).rejects.toThrow(DeploymentHeld);
    expect(sameProcess(f.runtime)).toBe(true);
    for (const monitor of f.bootstrap.running!) expect(sameProcess(monitor.identity!)).toBe(true);
    expect(existsSync(f.effect)).toBe(false);
    expect(existsSync(f.signalPath)).toBe(false);
    expect(JSON.parse(readFileSync(f.journal, "utf8"))).toMatchObject({
      status: "starting",
      step: "rollback",
      ...(prior ? { rollbackLaunchRequestedAt: f.launchRequestedAt } : {}),
    });
    expect(f.record.rollbackProcess).toBeUndefined();
  },
);

posix.each(["status", "role"] as const)(
  "a matching live rollback actor with lagging %s metadata never receives a duplicate command",
  async (missing) => {
    const f = await managedBashFixture();
    f.record.step = "rollback";
    f.record.rollbackRequestedAt = f.launchRequestedAt;
    f.record.rollbackLaunchRequestedAt = f.launchRequestedAt;
    if (missing === "role") f.writeState({ role: "lane" });
    f.writeObservation(missing === "status" ? "unknown" : undefined);
    f.persist(f.record);
    await expect(rollbackDeployment(f.config, f.record, f.persist)).rejects.toThrow(LaunchedProcessHeld);
    expect(sameProcess(f.runtime)).toBe(true);
    expect(existsSync(f.effect)).toBe(false);
    expect(existsSync(f.signalPath)).toBe(false);
    expect(f.record.rollbackLaunchRequestedAt).toBe(f.launchRequestedAt);
  },
);

posix.each(["suspended", "background"] as const)(
  "bare-root metadata cannot hide a real %s native descendant when its role receipt lags",
  async (mode) => {
    const f = await managedBashFixture();
    const rootPid = f.front.shell_pid;
    process.kill(-f.runtime.pid, "SIGSTOP");
    try {
      if (mode === "background") {
        const resumed = join(f.root, "background-resumed");
        writeFileSync(resumed, "");
        const watcher = watch(resumed);
        try {
          const changed = once(watcher, "change");
          f.sendLine(`bg; printf '%s' "$?" > ${JSON.stringify(resumed)}`);
          await changed;
          expect(readFileSync(resumed, "utf8")).toBe("0");
        } finally {
          watcher.close();
        }
      }
      const status = await f.cli.exec("ps", ["-o", "stat=", "-p", String(f.runtime.pid)]);
      expect(status.code).toBe(0);
      expect(status.stdout.trim().startsWith("T")).toBe(mode === "suspended");
      expect(procChildren(rootPid).join(" ")).not.toBe("");
      f.front.foreground_process_group_id = rootPid;
      f.front.foreground_processes = [
        {
          pid: rootPid,
          name: "bash",
          argv: procCmdline(rootPid).split("\0").filter(Boolean),
        },
      ];
      f.writeState({ pid: f.previousRuntime!.pid });
      expect(processIdentity(f.previousRuntime!.pid)).toBeUndefined();
      f.record.step = "rollback";
      f.record.rollbackRequestedAt = f.launchRequestedAt;
      f.record.rollbackLaunchRequestedAt = f.launchRequestedAt;
      f.persist(f.record);
      f.writeObservation();
      const cli = nativeCli(f.config);
      await expect(requireShell(f.config, cli)).rejects.toThrow(DeploymentHeld);
      await expect(rollbackDeployment(f.config, f.record, f.persist)).rejects.toThrow(DeploymentHeld);
      expect(sameProcess(f.runtime)).toBe(true);
      expect(existsSync(f.effect)).toBe(false);
      expect(existsSync(f.signalPath)).toBe(false);
    } finally {
      if (sameProcess(f.runtime)) process.kill(-f.runtime.pid, "SIGCONT");
    }
  },
);
