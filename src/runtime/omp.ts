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
  const doriHome = env["DORI_HOME"] ?? join(homedir(), ".dori");
  const path = env["DORI_CONFIG"] ?? join(doriHome, "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return join(doriHome, "state");
  }
  const config = JSON.parse(raw) as { stateDir?: string };
  return expandHome(config.stateDir ?? join(doriHome, "state"));
}

// The one classification of OMP's launch forms: the `omp` command, its published package CLI under Bun or Node, and the
// pinned source launcher (`bun --preload <pkg>/scripts/omp.ts [--preload <timer>] <pkg>/[scripts/../]src/cli.ts`).
// Each representation has its own parser below; none of them attests a live process (withOmpState does that).
const OMP_COMMAND =
  /^(?:(?:\S*\/)?(?:bun|node)(?:\s+-\S+)*\s+)?(?:\S*\/)?omp(?:\s|$)|^(?:\S*\/)?(?:bun|node)(?:\s+-\S+)*\s+\S*@oh-my-pi\/pi-coding-agent\/dist\/cli\.js(?:\s|$)/;
const SOURCE_OMP_COMMAND =
  /^(?:\S*\/)?bun\s+--preload\s+(.+\/packages\/coding-agent\/)scripts\/omp\.ts\s+(?:--preload\s+\1scripts\/\.\.\/\.\.\/utils\/src\/module-timer\.ts\s+)?\1(?:scripts\/\.\.\/)?src\/cli\.ts(?:\s|$)/;
export const OMP_EXECUTABLE = /(?:^|\/)omp$|@oh-my-pi\/pi-coding-agent\/dist\/cli\.js$/;

/** The pinned source launcher's exact argv (see SOURCE_OMP_COMMAND for its `ps` line). */
export const sourceOmpArgv = (argv: readonly string[]): boolean => {
  if (!/(?:^|\/)bun$/.test(argv[0] ?? "") || argv[1] !== "--preload") return false;
  const root = /^(.+\/packages\/coding-agent\/)scripts\/omp\.ts$/.exec(argv[2] ?? "")?.[1];
  if (root === undefined) return false;
  const timing = argv[3] === "--preload";
  if (timing && argv[4] !== `${root}scripts/../../utils/src/module-timer.ts`) return false;
  const entry = argv[timing ? 5 : 3];
  return entry === `${root}src/cli.ts` || entry === `${root}scripts/../src/cli.ts`;
};

/** A `ps` command line of an OMP process. Its argument boundaries are lost, so source roots may contain spaces. */
export const isOmpProcessCommand = (command: string): boolean =>
  OMP_COMMAND.test(command) || SOURCE_OMP_COMMAND.test(command);

/**
 * A `ps` command line that names OMP anywhere, as `bun run <omp>` or a published CLI under a spaced root does. Only
 * discovery without the extension's record uses it (the start-time session folder); trust keeps the exact forms above.
 */
export const namesOmpProcess = (command: string): boolean =>
  isOmpProcessCommand(command) || /(?:^|\s)(?:\S*\/)?omp(?:\s|$)|pi-coding-agent\/dist\/cli\.js/.test(command);

const ompProcess = (p: ForegroundProcess): boolean =>
  p.name.split("/").at(-1) === "omp" ||
  p.argv.slice(0, 2).some((arg) => OMP_EXECUTABLE.test(arg)) ||
  sourceOmpArgv(p.argv);

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
      !isOmpProcessCommand(writer.command) ||
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
