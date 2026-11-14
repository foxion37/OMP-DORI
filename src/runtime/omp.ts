import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec.ts";
import type { ForegroundProcess, Probe } from "./types.ts";

type Env = Readonly<Record<string, string | undefined>>;
type PaneState = {
  readonly paneId: string;
  readonly role: "dori" | "lane";
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly approvalPending: boolean;
  readonly agentStatus?: "idle" | "working";
};
type Proc = { readonly pid: number; readonly ppid: number; readonly command: string };

const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/** The extension's config/state precedence; callers with loaded config pass stateDir explicitly. */
export function ompStateDir(env: Env): string {
  if (env["DORI_STATE_DIR"] !== undefined) return expandHome(env["DORI_STATE_DIR"]);
  const path = env["DORI_CONFIG"] ?? join(homedir(), ".dori", "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return join(homedir(), ".dori", "state");
  }
  const config = JSON.parse(raw) as { stateDir?: string };
  return expandHome(config.stateDir ?? join(homedir(), ".dori", "state"));
}

const OMP_COMMAND =
  /^(?:(?:\S*\/)?(?:bun|node)(?:\s+-\S+)*\s+)?(?:\S*\/)?omp(?:\s|$)|^(?:\S*\/)?(?:bun|node)(?:\s+-\S+)*\s+\S*@oh-my-pi\/pi-coding-agent\/dist\/cli\.js(?:\s|$)/;
const ompProcess = (p: ForegroundProcess): boolean =>
  p.name.split("/").at(-1) === "omp" ||
  p.argv.slice(0, 2).some((arg) => /(?:^|\/)omp$|@oh-my-pi\/pi-coding-agent\/dist\/cli\.js$/.test(arg));

function readState(stateDir: string, id: string): PaneState | undefined {
  try {
    const state = JSON.parse(
      readFileSync(join(stateDir, "sessions", `${encodeURIComponent(id)}.json`), "utf8"),
    ) as PaneState;
    if (
      state.paneId !== id ||
      (state.role !== "dori" && state.role !== "lane") ||
      typeof state.sessionId !== "string" ||
      state.sessionId === "" ||
      !Number.isSafeInteger(state.pid) ||
      state.pid <= 0 ||
      typeof state.approvalPending !== "boolean" ||
      typeof state.startedAt !== "string" ||
      typeof state.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(state.startedAt)) ||
      !Number.isFinite(Date.parse(state.updatedAt)) ||
      Date.parse(state.updatedAt) < Date.parse(state.startedAt) ||
      (state.sessionFile !== undefined && typeof state.sessionFile !== "string")
    ) {
      return undefined;
    }
    return state;
  } catch {
    return undefined;
  }
}

function under(table: readonly Proc[], pid: number, root: number): boolean {
  const seen = new Set<number>();
  for (
    let at: number | undefined = pid;
    at !== undefined && !seen.has(at);
    at = table.find((p) => p.pid === at)?.ppid
  ) {
    if (at === root) return true;
    seen.add(at);
  }
  return false;
}

/** A live OMP writer attests to identity; only its own non-shell foreground can receive delivery. */
export async function withOmpState(exec: Exec, stateDir: string, id: string, probe: Probe): Promise<Probe> {
  if (probe.status === "gone") return probe;
  const state = readState(stateDir, id);
  const omp = probe.agent === "omp" || probe.foreground?.some(ompProcess) === true;
  const unknown = (): Probe => ({ ...probe, status: "unknown" });
  if (state === undefined) return omp && !probe.shellInFront ? unknown() : probe;
  if (probe.rootPid === undefined || !Number.isSafeInteger(probe.rootPid) || probe.rootPid <= 0) return unknown();
  try {
    const result = await exec("ps", ["-A", "-o", "pid=,ppid=,command="]);
    if (result.code !== 0) return unknown();
    const table = result.stdout.split("\n").flatMap((line): Proc[] => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }] : [];
    });
    const writer = table.find((p) => p.pid === state.pid);
    if (
      writer === undefined ||
      !OMP_COMMAND.test(writer.command) ||
      !under(table, writer.pid, probe.rootPid) ||
      (!probe.shellInFront && !probe.foreground?.some((p) => p.pid !== undefined && under(table, p.pid, writer.pid)))
    ) {
      return unknown();
    }
    // PIDs can be reused under the same shell: a newer process cannot have written an older session record.
    const start = await exec("ps", ["-o", "lstart=", "-p", String(writer.pid)]);
    const started = Date.parse(start.stdout.trim());
    if (start.code !== 0 || !Number.isFinite(started) || started > Date.parse(state.startedAt)) return unknown();
    const current = readState(stateDir, id);
    if (
      current === undefined ||
      current.pid !== state.pid ||
      current.sessionId !== state.sessionId ||
      current.startedAt !== state.startedAt
    ) {
      return unknown();
    }
    const status =
      (probe.status === "idle" || probe.status === "working") &&
      (current.agentStatus === "idle" || current.agentStatus === "working")
        ? current.agentStatus
        : probe.status;
    return {
      ...probe,
      status: current.approvalPending ? "blocked" : status,
      pid: current.pid,
      sessionId: current.sessionId,
      ...(current.sessionFile === undefined ? {} : { sessionFile: current.sessionFile }),
      approvalPending: current.approvalPending,
    };
  } catch {
    return unknown();
  }
}
