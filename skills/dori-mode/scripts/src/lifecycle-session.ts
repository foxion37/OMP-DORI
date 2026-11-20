import { readdirSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { SHELLS } from "../../../../src/runtime/foreground.ts";
import type { Probe, SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { GoalStatus, PaneState } from "./lane-state.ts";
import { LaunchError } from "./launch.ts";
import type { Lane } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { sessionDirFor, sessionFileStart, trustedPaneState } from "./session-id.ts";

export const confirmedLaneState = async (deps: FlowDeps, lane: Lane, ref: SessionRef): Promise<PaneState | null> => {
  if (!lane.session) return null;
  try {
    const state = await trustedPaneState(deps.run, deps.config.stateDir, ref, runtimesOf(deps), true);
    return state?.role === "lane" &&
      state.sessionId === lane.session &&
      state.approvalPending === false &&
      realpathSync(state.cwd) === realpathSync(lane.cwd ?? deps.config.defaultCwd)
      ? state
      : null;
  } catch {
    return null; // No trustworthy identity if the runtime or cwd cannot be read.
  }
};

export const nativeGoalStatus = (state: PaneState | null): GoalStatus | undefined => {
  const status = state?.goal?.status;
  switch (status) {
    case "none":
    case "active":
    case "paused":
    case "complete":
    case "dropped":
    case "blocked":
      return status;
    default:
      return undefined;
  }
};

export const isBareLaneShell = (probe: Probe): boolean => {
  const shell = probe.foreground?.[0];
  return (
    probe.shellInFront &&
    !probe.pid &&
    probe.foreground?.length === 1 &&
    shell !== undefined &&
    SHELLS.has(shell.name.replace(/^-/, "").split("/").pop() ?? "") &&
    shell.argv.length === 1
  );
};

/** Resolve an exact saved session, not OMP's interactive/partial-id resume selector. */
export const resumeFile = async (deps: FlowDeps, lane: Lane): Promise<string> => {
  try {
    return await readResumeFile(deps, lane);
  } catch (error) {
    if (error instanceof LaunchError) throw error;
    throw new LaunchError(
      `lane ${lane.key} saved session or cwd unavailable (${(error as NodeJS.ErrnoException).code ?? "invalid session header"})`,
    );
  }
};

/** OMP's own bound for finding the title slot and session header (SESSION_HEADER_READ_LIMIT). */
const HEADER_READ_LIMIT = 1024 * 1024;

/** OMP's optional fixed-width title slot (v1), only ever the first physical line before the session header. */
const isTitleSlot = (entry: Record<string, unknown>): boolean =>
  entry["type"] === "title" &&
  entry["v"] === 1 &&
  typeof entry["title"] === "string" &&
  typeof entry["updatedAt"] === "string" &&
  typeof entry["pad"] === "string" &&
  (entry["source"] === undefined || entry["source"] === "auto" || entry["source"] === "user");

const readResumeFile = async (deps: FlowDeps, lane: Lane): Promise<string> => {
  if (!lane.session) throw new LaunchError(`lane ${lane.key} has no recorded session; sync it before parking`);
  let file = lane.sessionFile;
  if (!file) {
    const dir = sessionDirFor(deps.config.sessionsDir, lane.cwd ?? deps.config.defaultCwd);
    const matches = readdirSync(dir).filter((name) => sessionFileStart(name)?.id === lane.session);
    if (matches.length !== 1) throw new LaunchError(`lane ${lane.key} has no unique saved session file`);
    file = join(dir, matches[0] ?? "");
  }
  // Records end only at LF bytes, as in OMP: readline would also split at a lone CR or U+2028/U+2029.
  await using handle = await open(file, "r");
  const head = Buffer.allocUnsafe(HEADER_READ_LIMIT); // Only the bytesRead prefix is ever decoded.
  const { bytesRead } = await handle.read(head, 0, head.length, 0);
  for (let start = 0, first = true; start < bytesRead; first = false) {
    const newline = head.subarray(start, bytesRead).indexOf(0x0a);
    // Without an LF, only a real end of file ends the record; a full window may have cut it off.
    if (newline === -1 && bytesRead === head.length)
      throw new LaunchError(`lane ${lane.key} saved session header is too long`);
    const end = newline === -1 ? bytesRead : start + newline;
    const header = JSON.parse(head.toString("utf8", start, end)) as Record<string, unknown>;
    start = end + 1;
    if (first && isTitleSlot(header)) continue;
    const cwd = header["cwd"];
    if (
      header["type"] !== "session" ||
      header["id"] !== lane.session ||
      typeof cwd !== "string" ||
      realpathSync(cwd) !== realpathSync(lane.cwd ?? deps.config.defaultCwd)
    )
      throw new LaunchError(`lane ${lane.key} saved session identity or cwd differs`);
    return realpathSync(file);
  }
  throw new LaunchError(`lane ${lane.key} saved session is empty`);
};
