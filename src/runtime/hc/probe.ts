import { interactiveShellInFront } from "../foreground.ts";
import { omoScreenIdle } from "../herdr/probe.ts";
import { withOmpState } from "../omp.ts";
import type { AgentStatus, ForegroundProcess, Probe, ProbeOptions } from "../types.ts";
import type { Exec } from "../exec.ts";
import { hcCall, isKind } from "./exec.ts";

/** Recent lines read to look for omo's idle input box (the same window the herdr runtime reads). */
const SCREEN_LINES = 30;

const REPORTED: ReadonlySet<string> = new Set(["idle", "working", "blocked", "error", "done"]);

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function foregroundOf(value: unknown): ForegroundProcess | undefined {
  const fg = rec(value);
  const name = text(fg?.["name"]);
  if (fg === undefined || name === undefined) return undefined;
  // Keep legacy hints for delivery holds; they are not positive bare-shell proof for close recovery.
  const raw = fg["argv"];
  const argv = Array.isArray(raw) ? raw.filter((arg): arg is string => typeof arg === "string") : [name];
  const pid = num(fg["pid"]);
  return {
    name,
    argv,
    ...(pid === undefined ? {} : { pid }),
    ...(Array.isArray(raw) && argv.length === raw.length ? {} : { argvIncomplete: true }),
  };
}

/** The status word of hc's `status` field (an object `{state}`, or a bare word in `ls` rows); undefined when it never reported. */
export function statusWord(value: unknown): AgentStatus | undefined {
  const word = typeof value === "string" ? value : text(rec(value)?.["state"]);
  if (word === undefined) return undefined;
  return REPORTED.has(word) ? (word as AgentStatus) : "unknown";
}

/**
 * One `hc get` record as a Probe. The status is the program's own OSC 7501 word; a program that never reported is a
 * `shell` when an interactive shell leads the foreground, else `unknown`. The screen check is applied by `probe`.
 */
export function parseProbe(terminal: unknown): Probe {
  const t = rec(terminal) ?? {};
  if (t["state"] === "finished") return { status: "gone", shellInFront: false };
  const fg = foregroundOf(t["foreground"]);
  const foreground = fg === undefined ? undefined : [fg];
  const shellInFront = interactiveShellInFront(foreground);
  const status = statusWord(t["status"]) ?? (shellInFront ? "shell" : "unknown");
  const agent = text(rec(t["status"])?.["app"]) ?? fg?.name;
  const [rootPid, turn, title, cwd] = [num(t["pid"]), num(t["turn"]), text(t["title"]), text(t["cwd"])];
  return {
    status,
    ...(agent === undefined ? {} : { agent }),
    ...(fg?.pid === undefined ? {} : { pgid: fg.pid }),
    ...(rootPid === undefined ? {} : { rootPid }),
    ...(turn === undefined ? {} : { turn }),
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    shellInFront,
    ...(foreground === undefined ? {} : { foreground }),
  };
}

/** #62 on hc: believe the screen only when it positively shows omo's idle input; a failed read is doubt and stays working. */
async function screenShowsIdle(exec: Exec, id: string): Promise<boolean> {
  try {
    const result = await hcCall(exec, ["read", id, "--lines", String(SCREEN_LINES)]);
    return typeof result["text"] === "string" && omoScreenIdle(result["text"]);
  } catch {
    return false;
  }
}

/** A probe plus hc's own status word, which `deliver` needs for its compare-and-send gate. */
export type HcProbe = { readonly probe: Probe; readonly word: AgentStatus };

async function getProbe(exec: Exec, id: string): Promise<Probe> {
  try {
    return parseProbe(await hcCall(exec, ["get", id]));
  } catch (e) {
    if (isKind(e, "not_found")) return { status: "gone", shellInFront: false };
    throw e;
  }
}

/**
 * `working` may be an idle omo with live monitors (#178). For bound delivery, refresh `hc get` after that screen
 * read, so process attestation and the compare-and-send word use the new foreground rather than the old sample.
 */
export async function probeWithWord(
  exec: Exec,
  id: string,
  stateDir?: string,
  mode: "observe" | "foreground-only" | "refresh-foreground" = "observe",
): Promise<HcProbe> {
  let parsed = await getProbe(exec, id);
  let idle = false;
  if (mode !== "foreground-only" && parsed.status === "working" && !parsed.shellInFront) {
    idle = await screenShowsIdle(exec, id);
    if (mode === "refresh-foreground") {
      const fresh = await getProbe(exec, id);
      const pid = parsed.foreground?.[0]?.pid;
      // A screen observation only describes the same terminal root and foreground process.
      idle = idle && pid !== undefined && fresh.foreground?.[0]?.pid === pid && fresh.rootPid === parsed.rootPid;
      parsed = fresh;
    }
  }
  const word = parsed.status;
  if (idle && word === "working" && !parsed.shellInFront) parsed = { ...parsed, status: "idle" };
  return { probe: stateDir === undefined ? parsed : await withOmpState(exec, stateDir, id, parsed), word };
}

export async function probe(exec: Exec, id: string, stateDir?: string, opts?: ProbeOptions): Promise<Probe> {
  return (await probeWithWord(exec, id, stateDir, opts?.foregroundOnly ? "foreground-only" : "observe")).probe;
}
