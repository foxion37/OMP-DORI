import { readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { Probe, SessionRef } from "../../../../src/runtime/types.ts";
import { type PaneState, readPaneState } from "./lane-state.ts";
import { type ChosenRuntimes, type Runner, runtimesFor } from "./run.ts";

export type Proc = { readonly pid: number; readonly ppid: number; readonly cmd: string };
export type SessionHit = {
  readonly id: string;
  readonly via: "extension" | "argv" | "child-env" | "start-time" | "none";
  readonly pid?: number;
};

const OMP = /(?:^|\s)(?:[^\s]*\/)?omp(\s|$)|pi-coding-agent\/dist\/cli\.js/;
const AGENT = /senpi\/dist\/bundle\/cli\.js|(?:^|\s)(?:[^\s]*\/)?(?:omo|omp)(\s|$)|pi-coding-agent\/dist\/cli\.js/;
const ENV_ID = /(?:^|\s)PI_SESSION_ID=([0-9a-f-]{36})(?:\s|$)/;
const SESSION_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/;
const START_WINDOW_MS = 180_000;

export const procTable = async (run: Runner): Promise<Proc[]> =>
  (await run(["ps", "-A", "-o", "pid=,ppid=,command="])).out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? "" }] : [];
  });

const descendants = (table: readonly Proc[], root: number): Proc[] => {
  const byParent = new Map<number, Proc[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const queue = [...(byParent.get(root) ?? [])];
  for (let p = queue.shift(); p; p = queue.shift()) {
    out.push(p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return out;
};

// OMP resolves equivalent paths before checking the temporary root and home, in that order.
const canonical = (path: string): string => {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
};
const isWithin = (rel: string): boolean => rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
const encodeRelative = (prefix: string, rel: string): string => {
  const encoded = rel.replace(/[/\\:]/g, "-");
  return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
};

/** OMP's temp-relative, home-relative, then legacy absolute session directory name. */
export const sessionDirFor = (sessionsDir: string, cwd: string, home = homedir(), tmp = tmpdir()): string => {
  const at = canonical(cwd);
  const inTmp = relative(canonical(tmp), at);
  const inHome = relative(canonical(home), at);
  const name = isWithin(inTmp)
    ? encodeRelative("-tmp", inTmp)
    : isWithin(inHome)
      ? encodeRelative("-", inHome)
      : `--${at.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsDir, name);
};

/** The session id and creation time a session file name carries, or undefined for any other file. */
export const sessionFileStart = (name: string): { readonly id: string; readonly at: number } | undefined => {
  const m = SESSION_FILE.exec(name);
  const at = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : Number.NaN;
  return m?.[5] && !Number.isNaN(at) ? { id: m[5], at } : undefined;
};

export type SessionDeps = {
  readonly run: Runner;
  /** Resolves the session's root process; built over `run` when absent (a stored ref needs no runtime choice). */
  readonly rts?: ChosenRuntimes;
  readonly sessionsDir: string;
  /** Where the OMP extension writes per-session runtime records. */
  readonly stateDir?: string;
  readonly listDir?: (dir: string) => readonly string[];
};

// The runtime validates OMP's writer pid, foreground membership, process start and current session together.
const sessionProcs = async (
  ref: SessionRef,
  table: readonly Proc[],
  deps: SessionDeps,
): Promise<{ readonly candidates: readonly Proc[]; readonly probe?: Probe }> => {
  const config = deps.stateDir === undefined ? {} : { stateDir: deps.stateDir };
  const rts = deps.rts ?? runtimesFor(config, process.env, deps.run);
  try {
    const probe = await rts.for(ref).probe(ref);
    const root = probe.rootPid;
    return { probe, candidates: root ? [...table.filter((p) => p.pid === root), ...descendants(table, root)] : [] };
  } catch {
    return { candidates: [] };
  }
};

const stateForAgent = (
  stateDir: string,
  ref: SessionRef,
  candidates: readonly Proc[],
  probe: Probe | undefined,
): PaneState | null => {
  const state = readPaneState(stateDir, ref.id);
  const agent = candidates.find((p) => p.pid === state?.pid && OMP.test(p.cmd) && !/\bmcp\b/.test(p.cmd));
  return state &&
    agent &&
    probe &&
    state.paneId === ref.id &&
    (state.role === "lane" || state.role === "dori") &&
    typeof state.sessionId === "string" &&
    state.sessionId.length > 0 &&
    typeof state.cwd === "string" &&
    (state.sessionFile === undefined || typeof state.sessionFile === "string") &&
    agent.pid === state.pid &&
    probe.pid === state.pid &&
    probe.sessionId === state.sessionId &&
    OMP.test(agent.cmd)
    ? state
    : null;
};

/** Only the current live OMP agent under this runtime's root may vouch for its session and goal. */
export const trustedPaneState = async (
  run: Runner,
  stateDir: string,
  ref: SessionRef,
  rts?: ChosenRuntimes,
): Promise<PaneState | null> => {
  if (!readPaneState(stateDir, ref.id)) return null;
  const deps: SessionDeps = { run, stateDir, sessionsDir: "", ...(rts === undefined ? {} : { rts }) };
  const { candidates, probe } = await sessionProcs(ref, await procTable(run), deps);
  return stateForAgent(stateDir, ref, candidates, probe);
};

export const resolveSession = async (
  ref: SessionRef,
  cwd: string,
  table: readonly Proc[],
  deps: SessionDeps,
): Promise<SessionHit> => {
  // The root itself is a candidate when hc or herdr runs OMP directly, without an intervening shell.
  const { candidates, probe } = await sessionProcs(ref, table, deps);
  const state = deps.stateDir === undefined ? null : stateForAgent(deps.stateDir, ref, candidates, probe);
  if (state) return { id: state.sessionId, via: "extension", pid: state.pid };
  const agent = candidates.find((p) => AGENT.test(p.cmd) && !/\bmcp\b/.test(p.cmd));
  if (!agent) return { id: "", via: "none" };
  // --session and PI_SESSION_ID belong to custom senpi/omo agents, never to OMP's current session.
  if (!OMP.test(agent.cmd)) {
    const argv = agent.cmd.split(/\s+/);
    const flagAt = argv.indexOf("--session");
    const fromFlag = flagAt >= 0 ? (argv[flagAt + 1] ?? "") : "";
    if (fromFlag) return { id: fromFlag, via: "argv", pid: agent.pid };
    for (const child of descendants(table, agent.pid).slice(0, 40)) {
      const env = await deps.run(["ps", "eww", "-o", "command=", "-p", String(child.pid)]);
      const hit = ENV_ID.exec(env.out);
      if (hit?.[1]) return { id: hit[1], via: "child-env", pid: agent.pid };
    }
  }
  const started = Date.parse((await deps.run(["ps", "-o", "lstart=", "-p", String(agent.pid)])).out);
  if (Number.isNaN(started)) return { id: "", via: "none", pid: agent.pid };
  const list =
    deps.listDir ??
    ((d: string) => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    });
  const dir = OMP.test(agent.cmd)
    ? sessionDirFor(deps.sessionsDir, cwd)
    : join(deps.sessionsDir, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
  const near = list(dir)
    .flatMap((name) => {
      const hit = sessionFileStart(name);
      return hit && hit.at >= started - 5_000 && hit.at <= started + START_WINDOW_MS ? [hit] : [];
    })
    .sort((a, b) => a.at - b.at);
  return near[0] ? { id: near[0].id, via: "start-time", pid: agent.pid } : { id: "", via: "none", pid: agent.pid };
};
