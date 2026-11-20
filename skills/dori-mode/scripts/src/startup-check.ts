import type { FlowDeps } from "./done-flow.ts";
import { mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { FIRST_CHECK_MS, launchFinished, launchScreen, launchStatus, lastLines } from "./launch-finished.ts";
import { startupFailure } from "./startup-screen.ts";
import { runtimesOf } from "./run.ts";

/** The statuses that mean the agent is up and taking turns: herdr reports a finished first turn as "done". */
export const ready = (s: string | undefined): boolean => s === "idle" || s === "working" || s === "done";

/**
 * One startup check for a session dori started outside a launch (a relay's successor): the screen for a known failure,
 * then the runtime's status. STARTUP_DONE when the session is gone and the lane already finished; a relay keeps its
 * old session unless this returns STARTUP_OK.
 */
export const checkStartup = async (deps: FlowDeps, key: string, ref: SessionRef): Promise<string> => {
  const rts = runtimesOf(deps);
  await deps.clock.sleep(FIRST_CHECK_MS);
  const screen = await launchScreen(deps, rts, ref, key);
  if (screen === null) return `STARTUP_DONE ${key}`;
  const omp = mayRunOmpArgv(deps.config.agentCommand);
  const bad = startupFailure(screen, omp);
  if (bad) return `STARTUP_ERROR ${key} ${ref.id}: ${bad}`;
  const { status, error } = await launchStatus(rts, ref, omp);
  if (status === "gone" && (await launchFinished(deps, key))) return `STARTUP_DONE ${key}`;
  if (ready(status)) return `STARTUP_OK ${key} ${ref.id}`;
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  return `STARTUP_UNCONFIRMED ${key} ${ref.id}: ${why}; last lines: ${lastLines(screen)}`;
};
