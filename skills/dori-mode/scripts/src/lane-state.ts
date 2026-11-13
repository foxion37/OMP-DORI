import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-pane state written by the omp-dori extension from inside a Dori or lane session and read by the `dori` CLI.
 * omp exposes no session id in argv or the environment and no goal readback on screen that dori can trust, so the
 * session reports itself here. One file per herdr pane; the extension is the only writer.
 */
export type DoriRole = "dori" | "lane";
export type GoalStatus = "none" | "active" | "paused" | "complete" | "dropped" | "blocked";

export type PaneState = {
  readonly paneId: string;
  readonly role: DoriRole;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly cwd: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly goal: { readonly status: GoalStatus; readonly objective?: string };
  /** A tool approval prompt is open in this session: never type into the pane. */
  readonly approvalPending: boolean;
  /** The session's current model as `provider/id`, refreshed on session start and every turn end. */
  readonly model?: string;
  /** Context window use at the last turn end; absent until omp can estimate it. */
  readonly context?: { readonly percent: number; readonly tokens: number; readonly window: number };
};

export const paneStateDir = (stateDir: string): string => join(stateDir, "sessions");

export const paneStatePath = (stateDir: string, paneId: string): string => join(paneStateDir(stateDir), `${encodeURIComponent(paneId)}.json`);

export const readPaneState = (stateDir: string, paneId: string): PaneState | null => {
  try {
    return JSON.parse(readFileSync(paneStatePath(stateDir, paneId), "utf8")) as PaneState;
  } catch {
    return null;
  }
};

// temp file + rename so a concurrent reader never sees a half-written state
export const writePaneState = (stateDir: string, state: PaneState): void => {
  mkdirSync(paneStateDir(stateDir), { recursive: true });
  const path = paneStatePath(stateDir, state.paneId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
};
