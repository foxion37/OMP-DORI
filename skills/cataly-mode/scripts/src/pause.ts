import { mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import { HeadlessRuntime } from "../../../../src/runtime/headless.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { type FlowDeps, movedOn } from "./done-flow.ts";
import type { GoalStatus } from "./lane-state.ts";
import { confirmedLaneState, nativeGoalStatus } from "./lifecycle-session.ts";
import { type Lane, type LaneStatus, sameLaneGeneration, sessionOf, statusOf, withStatus } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";
import { readScreen, sendVerified, statusLookup } from "./sessions.ts";

/**
 * One state for "wait": a paused lane is skipped by the freshness sweep and its agent's goal is paused,
 * so neither a nudge nor goal continuation wakes it until it is resumed (issue #11). The lane is marked
 * paused only once its current session reports the goal paused: silencing a live goal alone leaves it running.
 */
export type PauseResult = { readonly lane: Lane; readonly lines: readonly string[]; readonly code: 0 | 2 | 3 };

const PAUSABLE: ReadonlySet<LaneStatus> = new Set(["working", "not-done"]);
// What the goal command prints (senpi goal/command-registration.ts): its new status, or that there is no goal,
// in which case nothing can auto-continue either.
// Whole lines only, so a lane's own output that merely mentions them does not count.
const PAUSED_SHOWN = /^\s*(?:Goal paused|cannot update goal: no goal exists)\s*$/gm;
const RESUMED_SHOWN = /^\s*(?:Goal active|cannot update goal: no goal exists)\s*$/gm;
// OMP prints these for an already paused goal too, so they only corroborate a completed/dropped goal record.
const NO_GOAL_SHOWN = /^\s*(?:No active goal to pause\.|No paused goal to resume\.)\s*$/gm;
const READ_BACK_TRIES = 8;

const count = (screen: string, shown: RegExp): number => screen.match(shown)?.length ?? 0;

/** OMP confirms through its trusted current-session state; custom agents retain their screen readback. */
const goalCommand = async (
  deps: FlowDeps,
  ref: SessionRef,
  text: string,
  target: GoalStatus,
  lane: Lane,
): Promise<
  | "confirmed"
  | "unconfirmed"
  | "failed"
  | "identity unverified before send"
  | "identity changed during readback"
  | "goal unverified before send"
  | "goal unverified during readback"
  | "lane changed before send"
> => {
  const rts = runtimesOf(deps);
  if (ref.runtime === "headless") {
    const runtime = rts.for(ref);
    if (!(runtime instanceof HeadlessRuntime) || !lane.session) return "identity unverified before send";
    const current = await deps.registry.read(lane.key);
    if (!current || !sameLaneGeneration(lane, current)) return "lane changed before send";
    try {
      const result = await runtime.setGoal(ref, lane.session, target === "paused" ? "paused" : "active");
      if (result.sessionId !== lane.session || result.held) return "identity changed during readback";
      const goal = result.goal?.status;
      return goal === target || goal === "none" || goal === "complete" || goal === "dropped"
        ? "confirmed"
        : "goal unverified during readback";
    } catch {
      return "unconfirmed";
    }
  }
  const prepared = lane.hold?.outcome !== undefined;
  const requireBinding = lane.session !== undefined || prepared;
  const native = prepared || mayRunOmpArgv(deps.config.agentCommand);
  let expectedSessionId: string | undefined;
  if (native) {
    const state = requireBinding
      ? await confirmedLaneState(deps, lane, ref)
      : await trustedPaneState(deps.run, deps.config.stateDir, ref, rts);
    if ((!state && requireBinding) || (state && (state.role !== "lane" || state.approvalPending !== false)))
      return "identity unverified before send";
    if (state && !nativeGoalStatus(state)) return "goal unverified before send";
    expectedSessionId = state?.sessionId;
  }
  const shown = native ? NO_GOAL_SHOWN : target === "paused" ? PAUSED_SHOWN : RESUMED_SHOWN;
  const before = count(await readScreen(rts, ref, 200), shown);
  const current = await deps.registry.read(lane.key);
  if (!current || !sameLaneGeneration(lane, current)) return "lane changed before send";
  if ((await sendVerified(rts, deps.clock, ref, text, undefined, expectedSessionId)) === "failed") return "failed";
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    if (native) {
      const state = requireBinding
        ? await confirmedLaneState(deps, lane, ref)
        : await trustedPaneState(deps.run, deps.config.stateDir, ref, rts);
      if (
        (!state && requireBinding) ||
        (state && (state.role !== "lane" || state.approvalPending !== false)) ||
        (expectedSessionId !== undefined && state?.sessionId !== expectedSessionId)
      )
        return "identity changed during readback";
      const goal = nativeGoalStatus(state);
      if (state && !goal) return "goal unverified during readback";
      if (goal === target || goal === "none") return "confirmed";
      if ((goal === "complete" || goal === "dropped") && count(await readScreen(rts, ref, 200), shown) > before)
        return "confirmed";
    } else if (count(await readScreen(rts, ref, 200), shown) > before) return "confirmed";
    await deps.clock.sleep(700);
  }
  return "unconfirmed";
};

/** The status a paused lane had before its pause. */
const beforePause = (lane: Lane): LaneStatus =>
  lane.pausedFrom && PAUSABLE.has(lane.pausedFrom) ? lane.pausedFrom : "working";

export const pauseLane = async (deps: FlowDeps, lane: Lane, note: string, locked = false): Promise<PauseResult> => {
  const status = statusOf(lane);
  if (!PAUSABLE.has(status) && status !== "paused")
    return { lane, lines: [`NOT_PAUSED ${lane.key} is ${status}, not working`], code: 2 };
  // The whole pause holds the lane's delivery lock, so a `cataly tell` cannot start a turn after its Escape.
  if (locked) return pauseHeld(deps, lane, note);
  const held = await withDeliveryLock(deps, lane.key, () => pauseHeld(deps, lane, note));
  if (held.ok) return held.value;
  return {
    lane,
    lines: [
      `PAUSE_UNVERIFIED ${lane.key} a message to the lane is in flight (delivery lock: ${held.holder}); lane left ${statusOf(lane)}`,
    ],
    code: 3,
  };
};

const pauseHeld = async (deps: FlowDeps, seen: Lane, note: string): Promise<PauseResult> => {
  const lane = await deps.registry.read(seen.key);
  if (!lane || !sameLaneGeneration(seen, lane))
    return { lane: lane ?? seen, lines: [await movedOn(deps, seen, "pause")], code: 3 };
  if (lane.nativeCloseIntent) return { lane, lines: [`HELD ${lane.key}: native close is in progress`], code: 3 };
  const status = statusOf(lane);
  if (status === "paused") return { lane, lines: [`PAUSED ${lane.key} already`], code: 0 };
  if (!PAUSABLE.has(status)) return { lane, lines: [`NOT_PAUSED ${lane.key} is ${status}, not working`], code: 2 };
  const ref = sessionOf(lane);
  if (!ref) return { lane, lines: [`PAUSE_UNVERIFIED ${lane.key} has no pane, so its goal cannot be paused`], code: 3 };
  // The goal first: stopping the running turn must not hand off to a goal continuation. sendVerified delivers it under
  // the status it reads, so a working agent gets it as queued input ("working"), an idle one under "idle".
  const goal = await goalCommand(deps, ref, "/goal pause", "paused", lane);
  if (goal !== "confirmed")
    return { lane, lines: [`PAUSE_UNVERIFIED ${lane.key} /goal pause ${goal}; lane left ${status}`], code: 3 };
  const at = new Date(deps.clock.now()).toISOString();
  // The goal command took pane round trips: a claim or close written meanwhile is not overwritten with paused.
  const paused = await deps.registry.transition(lane, (current) =>
    withStatus(current, "paused", note, at, {
      pausedFrom: status,
      pausedSeenWorking: undefined,
      lastFreshnessNote: undefined,
    }),
  );
  if (!paused) return { lane, lines: [await movedOn(deps, lane, "pause (its goal is paused)")], code: 3 };
  if (ref.runtime === "headless")
    return { lane: paused, lines: [`PAUSED ${lane.key} native goal and turn held`], code: 0 };
  const rts = runtimesOf(deps);
  const running = (await statusLookup(rts, ref)).status === "working";
  if (running) {
    if (lane.session && mayRunOmpArgv(deps.config.agentCommand)) {
      const state = await confirmedLaneState(deps, paused, ref);
      if (!nativeGoalStatus(state))
        return { lane: paused, lines: [`PAUSE_UNVERIFIED ${lane.key} pane unverified; turn not interrupted`], code: 3 };
    }
    const current = await deps.registry.read(lane.key);
    if (!current || !sameLaneGeneration(paused, current))
      return { lane: current ?? paused, lines: [await movedOn(deps, paused, "pause interruption")], code: 3 };
    await rts.terminal(ref.runtime).keys(ref, ["escape"]);
  }
  return {
    lane: paused,
    lines: [`PAUSED ${lane.key} goal paused${running ? ", running turn interrupted" : ""}`],
    code: 0,
  };
};

export const resumeLane = async (deps: FlowDeps, seen: Lane, note: string, locked = false): Promise<PauseResult> => {
  const status = statusOf(seen);
  if (status !== "paused") return { lane: seen, lines: [`NOT_RESUMED ${seen.key} is ${status}, not paused`], code: 2 };
  if (!locked) {
    const held = await withDeliveryLock(deps, seen.key, () => resumeLane(deps, seen, note, true));
    return held.ok
      ? held.value
      : { lane: seen, lines: [`RESUME_UNVERIFIED ${seen.key} delivery lock: ${held.holder}`], code: 3 };
  }
  const lane = await deps.registry.read(seen.key);
  if (!lane || !sameLaneGeneration(seen, lane))
    return { lane: lane ?? seen, lines: [await movedOn(deps, seen, "resume")], code: 3 };
  if (lane.nativeCloseIntent) return { lane, lines: [`HELD ${lane.key}: native close is in progress`], code: 3 };
  if (statusOf(lane) !== "paused")
    return { lane, lines: [`NOT_RESUMED ${lane.key} is ${statusOf(lane)}, not paused`], code: 2 };
  const ref = sessionOf(lane);
  if (!ref)
    return { lane, lines: [`RESUME_UNVERIFIED ${lane.key} has no pane, so its goal cannot be resumed`], code: 3 };
  const goal = await goalCommand(deps, ref, "/goal resume", "active", lane);
  if (goal !== "confirmed")
    return { lane, lines: [`RESUME_UNVERIFIED ${lane.key} /goal resume ${goal}; lane left paused`], code: 3 };
  const now = deps.clock.now();
  // Quiet time starts again at the resume: a long pause must not turn into an instant nudge.
  const resumed = await deps.registry.transition(lane, (current) => {
    const { hold, ...rest } = current;
    return withStatus(hold?.outcome ? rest : current, beforePause(current), note, new Date(now).toISOString(), {
      lastReplyAt: now,
      pausedFrom: undefined,
      pausedSeenWorking: undefined,
      lastFreshnessNote: undefined,
    });
  });
  if (!resumed) return { lane, lines: [await movedOn(deps, lane, "resume (its goal is resumed)")], code: 3 };
  return { lane: resumed, lines: [`RESUMED ${lane.key} as ${statusOf(resumed)}, goal resumed`], code: 0 };
};

export type PausedCheck = { readonly lane: Lane; readonly outcome: "working-while-paused" } | null;

/**
 * Resume is explicit only: `cataly resume`, on the owner's word. Activity never ends a pause, because a paused
 * lane can still be woken (a background result, a queued message, a turn after Escape) and its owner said
 * wait. A paused lane whose pane reads working on two ticks in a row is reported so the lead can ask; it
 * stays paused.
 */
export const checkPausedLane = async (deps: FlowDeps, lane: Lane): Promise<PausedCheck> => {
  const ref = sessionOf(lane);
  if (statusOf(lane) !== "paused" || !ref) return null;
  const working = (await statusLookup(runtimesOf(deps), ref)).status === "working";
  if (!working) {
    // Idle again: the next working stretch is new information and is reported again.
    if (lane.pausedSeenWorking || lane.lastFreshnessNote)
      await deps.registry.transition(lane, (current) => ({
        ...current,
        pausedSeenWorking: undefined,
        lastFreshnessNote: undefined,
      }));
    return null;
  }
  // Only while the lane is still paused: a resume written during the status read is never turned back.
  if (!lane.pausedSeenWorking) {
    await deps.registry.transition(lane, (current) => ({ ...current, pausedSeenWorking: true }));
    return null;
  }
  return { lane, outcome: "working-while-paused" };
};
