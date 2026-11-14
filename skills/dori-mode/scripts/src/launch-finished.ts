import type { Runtimes } from "../../../../src/runtime/registry.ts";
import { isKind } from "../../../../src/runtime/hc/exec.ts";
import { reasonOf, ToolError } from "../../../../src/runtime/herdr/exec.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { finished } from "./boot-monitors.ts";
import type { FlowDeps } from "./done-flow.ts";
import { Reports } from "./reports.ts";
import { startupScreen } from "./startup-screen.ts";

/** The first startup check runs 20 s after the start; launch re-reads the screen and status every 10 s after it. */
export const FIRST_CHECK_MS = 20_000;

/** The last lines of a screen, paths masked, for a startup line: never the whole screen, never a local path. */
export const lastLines = (screen: string): string =>
  screen
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" / ")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .slice(0, 240) || "(blank)";

const missingSession = (ref: SessionRef, error: unknown): boolean =>
  isKind(error, "not_found") ||
  (ref.runtime === "herdr" && error instanceof ToolError && /not.?found/i.test(reasonOf(error)));

export const launchFinished = async (deps: FlowDeps, key: string): Promise<boolean> => {
  const lane = await deps.registry.read(key);
  return lane !== null && finished({ ...lane, reportState: new Reports(deps.config.stateDir).read(key)?.state });
};

export const launchScreen = async (
  deps: FlowDeps,
  rts: Runtimes,
  ref: SessionRef,
  key: string,
): Promise<string | null> => {
  try {
    return await startupScreen(rts, ref);
  } catch (error) {
    if (missingSession(ref, error) && (await launchFinished(deps, key))) return null;
    throw error;
  }
};

/**
 * The runtime's own status word for the lane's session. Unlike agentStatus it keeps `shell` (no agent in the session)
 * apart from no status yet: herdr lists an agent that has not reported as `unknown` and a pane with no agent as `shell`.
 * hc lists both with no status, so a session listed with none is probed, which names a shell in front. A session missing
 * from the list is `gone`. OMP instead uses its live-process-bound probe, including approval and shell guards.
 */
export const launchStatus = async (
  rts: Runtimes,
  ref: SessionRef,
  ompAgent: boolean,
): Promise<{ status?: string; error?: string }> => {
  try {
    if (ompAgent) {
      const seen = await rts.for(ref).probe(ref);
      return { status: seen.status !== "gone" && seen.shellInFront ? "shell" : seen.status };
    }
    const found = (await rts.for(ref).list()).find((s) => s.ref.id === ref.id);
    if (!found) return { status: "gone" };
    if (found.status !== undefined) return { status: found.status };
    const probed = (await rts.for(ref).probe(ref)).status;
    return probed === "shell" || probed === "gone" ? { status: probed } : {};
  } catch (e) {
    if (missingSession(ref, e)) return { status: "gone" };
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
