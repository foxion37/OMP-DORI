import { mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import { unpushedWork } from "./close-worktrees.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { type FlowDeps, movedOn } from "./done-flow.ts";
import { confirmedLaneState, isBareLaneShell, nativeGoalStatus, resumeFile } from "./lifecycle-session.ts";
import { pendingDiscordLane } from "./messenger/discord-lane-inbox.ts";
import { pauseLane, type PauseResult } from "./pause.ts";
import { type Lane, sameLaneGeneration, sessionOf, statusOf, withStatus } from "./registry.ts";
import { iso, runtimesOf } from "./run.ts";
import { withThreadLock } from "./thread-groups.ts";

/** Terminal suspension preserves files and never claims Done or runs threadDone. */
export const parkLane = async (
  deps: FlowDeps,
  seen: Lane,
  note: string,
  outcome: "parked" | "abandoned" = "parked",
  resumeWhen?: string,
): Promise<PauseResult> => {
  const held = await withDeliveryLock(deps, seen.key, async (): Promise<PauseResult> => {
    const current = await deps.registry.read(seen.key);
    if (!current || !sameLaneGeneration(seen, current))
      return { lane: seen, lines: [await movedOn(deps, seen, outcome)], code: 3 };
    let lane = current;
    const fail = (text: string, code: 2 | 3 = 3): PauseResult => ({ lane, lines: [text], code });
    if (lane.nativeCloseIntent) return fail(`HELD ${lane.key}: native close is in progress`);
    if (!note.trim()) return fail(`REFUSED ${lane.key}: a reason is required`, 2);
    if (!["working", "not-done", "paused"].includes(statusOf(lane)))
      return fail(`REFUSED ${lane.key}: ${statusOf(lane)} cannot be ${outcome}`, 2);
    if (pendingDiscordLane(deps.config.stateDir, lane))
      return fail(`HELD ${lane.key}: Discord messages are still pending`);
    const saved = lane.hold?.outcome ? lane.hold : undefined;
    if (saved && saved.outcome !== outcome)
      return fail(`REFUSED ${lane.key}: terminal intent is already ${saved.outcome}`, 2);
    const hold = saved ?? { outcome, reason: note, ...(resumeWhen ? { resumeWhen } : {}) };
    const reason = hold.reason;
    const group = await withThreadLock(deps, lane, async (): Promise<PauseResult> => {
      const member = await deps.registry.read(lane.key);
      if (!member || member.thread !== lane.thread || !sameLaneGeneration(lane, member))
        return fail(await movedOn(deps, lane, outcome));
      if (pendingDiscordLane(deps.config.stateDir, member))
        return fail(`HELD ${lane.key}: Discord messages are still pending`);
      const ref = sessionOf(lane);
      const runtime = ref && runtimesOf(deps).for(ref);
      const isPresent = async () =>
        runtime &&
        ref &&
        (ref.runtime === "headless"
          ? (await runtime.probe(ref)).status !== "gone"
          : (await runtime.list()).some((s) => s.ref.id === ref.id));
      const live = await isPresent();
      const bareShell = async () => !!(runtime && ref && isBareLaneShell(await runtime.probe(ref)));
      let stoppedShell = false;
      if (outcome === "abandoned" && live) {
        try {
          stoppedShell = await bareShell();
        } catch {
          return fail(`ABANDON_UNVERIFIED ${lane.key}: cannot confirm pane ${ref?.id}; no pane closed`);
        }
      }
      const state = live && ref && !stoppedShell ? await confirmedLaneState(deps, lane, ref) : null;
      if (live && !stoppedShell && !state)
        return fail(
          `PARK_UNVERIFIED ${lane.key}: ${lane.session ? "session identity or approval state unconfirmed" : "no bound session; run cataly sync --write first"}`,
        );
      if (state && !nativeGoalStatus(state)) return fail(`PARK_UNVERIFIED ${lane.key}: goal state unconfirmed`);
      const quiescent = async () => {
        if (stoppedShell) return bareShell().catch(() => false);
        const goal = ref && nativeGoalStatus(await confirmedLaneState(deps, lane, ref));
        return goal === "paused" || goal === "none" || goal === "complete" || goal === "dropped";
      };
      let sessionFile = lane.sessionFile;
      if (outcome === "parked") {
        if (!mayRunOmpArgv(deps.config.agentCommand)) return fail(`REFUSED ${lane.key}: park requires OMP`, 2);
        if (!live && (!saved || statusOf(lane) !== "paused"))
          return fail(`PARK_UNVERIFIED ${lane.key}: no live lane to pause`);
        const file = sessionFile ?? state?.sessionFile;
        sessionFile = await resumeFile(deps, file ? { ...lane, sessionFile: file } : lane);
      }
      if (live && !stoppedShell) {
        const paused = await pauseLane(deps, lane, reason, true);
        if (paused.code !== 0) return paused;
        lane = paused.lane;
      }
      const warnings = await unpushedWork(deps, lane);
      const changed = `PARK_UNVERIFIED ${lane.key}: session, goal or shell changed before close`;
      if (!saved || sessionFile !== lane.sessionFile) {
        if (live && !(await quiescent())) return fail(changed);
        // Preserve the original intent even if pane close and receipt commit are interrupted.
        const prepared = await deps.registry.transition(lane, (entry) =>
          withStatus(entry, "paused", `${outcome}: ${reason}`, iso(deps.clock), {
            ...(sessionFile ? { sessionFile } : {}),
            hold,
          }),
        );
        if (!prepared) return fail(await movedOn(deps, lane, outcome));
        lane = prepared;
      }
      if (live && ref && runtime) {
        const latest = await deps.registry.read(lane.key);
        if (!latest || !sameLaneGeneration(lane, latest)) return fail(await movedOn(deps, lane, outcome));
        if (latest.session !== lane.session || !(await quiescent())) return fail(changed);
        try {
          // Close only the recorded pane, never unrelated panes later added to its tab.
          if (ref.runtime === "headless") await runtime.close(ref, "session", lane.session);
          else await runtime.close(ref, "session");
          if (await isPresent()) return fail(`PARK_UNVERIFIED ${lane.key}: pane still present; files kept`);
        } catch (error) {
          return fail(`PARK_UNVERIFIED ${lane.key}: close failed (${String(error)}); files kept`);
        }
      }
      const at = iso(deps.clock);
      const receipt = {
        outcome,
        note: reason,
        at,
        cleanup: ["worktrees kept", live ? "pane closed" : "pane absent"],
        warnings,
      };
      const closed = await deps.registry.transition(lane, (current) =>
        withStatus(current, "closed", `${outcome}: ${reason}`, at, { closedAt: at, receipt }),
      );
      if (!closed) return fail(await movedOn(deps, lane, `${outcome} (pane closed)`));
      return {
        lane: closed,
        code: 0,
        lines: [
          ...warnings.map((w) => `WARNING ${w}; preserved`),
          `${outcome === "parked" ? "PARKED" : "ABANDONED"} ${lane.key} ${JSON.stringify(receipt)}`,
        ],
      };
    });
    return group.ok ? group.value : fail(`HELD ${lane.key} thread close in flight (${group.holder})`);
  });
  return held.ok ? held.value : { lane: seen, lines: [`HELD ${seen.key} delivery lock: ${held.holder}`], code: 3 };
};
