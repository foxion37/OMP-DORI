import { basename } from "node:path";
import type { Exec } from "../runtime/exec.ts";
import { interactiveShellInFront } from "../runtime/foreground.ts";
import { hcCall, isKind } from "../runtime/hc/exec.ts";
import { probe as hcProbe } from "../runtime/hc/probe.ts";
import { HerdrCli, reasonOf } from "../runtime/herdr/exec.ts";
import { type Front, foreground as herdrForeground, probe as herdrProbe } from "../runtime/herdr/probe.ts";
import { start as herdrStart } from "../runtime/herdr/sessions.ts";
import type { ForegroundProcess, Probe } from "../runtime/types.ts";
import { procChildren, procCmdline, procExeTarget, procStat } from "./proc.ts";

/** The terminal operations a managed replacement performs on the Dori's own pane or terminal. */
export interface DeploymentCli {
  readonly exec: Exec;
  probe(pane: string, onFail: string, stateDir: string): Promise<Probe>;
  foreground(pane: string, onFail: string): Promise<Front>;
  start(pane: string, command: string): Promise<void>;
  readonly nativeUi?: {
    read(pane: string, lines: number): Promise<string>;
    exit(pane: string): Promise<void>;
  };
}

export function herdrDeploymentCli(exec: Exec, session?: string): DeploymentCli {
  const cli = new HerdrCli(exec, session);
  return {
    exec,
    probe: (pane, onFail, stateDir) => herdrProbe(cli, pane, false, onFail, stateDir),
    foreground: (pane, onFail) => herdrForeground(cli, pane, onFail),
    start: (pane, command) => herdrStart(cli, pane, command),
    ...(process.platform === "linux"
      ? {
          nativeUi: {
            read: (pane: string, lines: number) => cli.read(pane, lines),
            exit: async (pane: string) => {
              await cli.call(["pane", "send-keys", pane, "ctrl+d"]);
            },
          },
        }
      : {}),
  };
}

/**
 * hc reports a terminal's root PID and only one foreground process, so the foreground group is rebuilt from the kernel:
 * the root's controlling-terminal group, and every descendant of the root in that group.
 */
export function kernelForeground(rootPid: number): Front {
  const pgid = procStat(rootPid).tpgid;
  if (pgid <= 0) throw new Error(`terminal root ${rootPid} has no foreground process group`);
  const members: ForegroundProcess[] = [];
  const seen = new Set<number>();
  const visit = (pid: number): void => {
    if (seen.has(pid)) return;
    seen.add(pid);
    if (procStat(pid).pgid === pgid) {
      const argv = procCmdline(pid).split("\0").filter(Boolean);
      members.push({ pid, name: basename(procExeTarget(pid)), argv });
    }
    for (const child of procChildren(pid, true)) visit(child);
  };
  visit(rootPid);
  return { shell: interactiveShellInFront(members), pgid, rootPid, processes: members };
}

export function hcDeploymentCli(exec: Exec): DeploymentCli {
  const rootOf = async (pane: string): Promise<number | undefined> => {
    try {
      const pid = (await hcCall(exec, ["get", pane]))["pid"];
      return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch (error) {
      if (isKind(error, "not_found")) return undefined;
      throw error;
    }
  };
  const foreground = async (pane: string, onFail: string): Promise<Front> => {
    try {
      const root = await rootOf(pane);
      if (root === undefined) throw new Error("terminal is gone");
      return kernelForeground(root);
    } catch (error) {
      process.stderr.write(`dori: hc foreground lookup failed for ${pane} (${reasonOf(error)}); ${onFail}\n`);
      return { shell: true };
    }
  };
  return {
    exec,
    probe: async (pane, onFail, stateDir) => {
      const seen = await hcProbe(exec, pane, stateDir);
      if (seen.status === "gone") return seen;
      const front = await foreground(pane, onFail);
      const { pgid: _pgid, rootPid: _rootPid, foreground: _foreground, ...rest } = seen;
      return {
        ...rest,
        shellInFront: front.shell,
        ...(front.pgid === undefined ? {} : { pgid: front.pgid }),
        ...(front.rootPid === undefined ? {} : { rootPid: front.rootPid }),
        ...(front.processes === undefined ? {} : { foreground: front.processes }),
      };
    },
    foreground,
    start: async (pane, command) => {
      await hcCall(exec, ["send", pane, "--", command]);
    },
  };
}
