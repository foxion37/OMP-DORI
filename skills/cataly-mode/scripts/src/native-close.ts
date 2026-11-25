import { HeadlessRuntime } from "../../../../src/runtime/headless.ts";
import type { Probe, SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { LessonInput } from "./lessons.ts";
import { confirmedLaneState, isBareLaneShell } from "./lifecycle-session.ts";
import { pendingDiscordLane } from "./messenger/discord-lane-inbox.ts";
import { type CloseProcess, processHold, processIdentity, sameProcess } from "./native-close-process.ts";
import { type Lane, sameLaneGeneration, sessionOf, statusOf, withStatus } from "./registry.ts";
import { iso, runtimesOf } from "./run.ts";
import type { Check } from "./signals.ts";

export type CloseLesson = Pick<LessonInput, "rule" | "evidence">;
type CloseBasis = {
  readonly note: string;
  readonly checks: readonly Check[];
  readonly settlingClaim: boolean;
  readonly lesson?: CloseLesson;
};
export type NativeCloseIntent = CloseBasis & {
  readonly ref: SessionRef;
  readonly session: string;
  readonly epoch?: string;
  /** Initial lanes have no reopen epoch; their original registration still binds the close. */
  readonly openedAt?: string;
  /** The kernel incarnation, independent of wall-clock and timezone changes. */
  readonly process?: CloseProcess;
};

// A Done decision and a prepared close contend only on the short registry writer lock. Neither waits for pane I/O.
export const recordDoneDecision = async (
  deps: FlowDeps,
  seen: Lane,
  next: (current: Lane) => Lane,
): Promise<Lane | "closing" | null> => {
  let closing = false;
  const result = await deps.registry.update(seen.key, (current) => {
    closing = current?.nativeCloseIntent !== undefined;
    if (!current || closing || statusOf(current) === "closed" || !sameLaneGeneration(seen, current)) return null;
    const { threadClosePending: _waiting, ...active } = current;
    return next(active);
  });
  return closing ? "closing" : result;
};

const boundTo = (lane: Lane, intent: NativeCloseIntent): boolean => {
  const ref = sessionOf(lane);
  return (
    lane.lifecycleEpoch === intent.epoch &&
    (intent.openedAt === undefined ? intent.epoch !== undefined : lane.openedAt === intent.openedAt) &&
    lane.session === intent.session &&
    ref !== undefined &&
    ref.runtime === intent.ref.runtime &&
    ref.id === intent.ref.id &&
    ref.group === intent.ref.group &&
    ref.container === intent.ref.container
  );
};

type CloseCommit =
  | { readonly kind: "closed"; readonly lane: Lane; readonly pane: string | undefined }
  | { readonly kind: "changed"; readonly pane?: string | undefined }
  | { readonly kind: "held"; readonly reason: string };

const recordClosed = async (deps: FlowDeps, lane: Lane, basis: CloseBasis): Promise<CloseCommit> => {
  const intent = lane.nativeCloseIntent;
  const at = iso(deps.clock);
  const closed = await deps.registry.transition(lane, (current) => {
    const { nativeCloseIntent: stored, threadClosePending: _waiting, ...cleared } = current;
    if (intent ? !stored || !boundTo(current, stored) || !boundTo(current, intent) : stored) return null;
    const verified = basis.settlingClaim
      ? withStatus(cleared, "verified-done", "Done signals read back live", at)
      : cleared;
    return withStatus(verified, "closed", basis.note, at, { closedAt: at });
  });
  const pane = intent?.ref.id;
  return closed ? { kind: "closed", lane: closed, pane } : { kind: "changed", pane };
};

/** Keep cleanup behind a fresh busy check and the observed native process's exit, not just pane disappearance. */
export const commitClose = async (deps: FlowDeps, seen: Lane, basis: CloseBasis): Promise<CloseCommit> => {
  const saved = seen.nativeCloseIntent;
  const target = sessionOf(seen);
  const initial = target?.runtime !== "headless" && seen.lifecycleEpoch === undefined && !saved;
  const hold = (reason: string): CloseCommit => ({ kind: "held", reason });
  const unconfirmed = "native pane identity or approval state is unconfirmed";
  const busy = "main agent is still working";
  const mainBusy = (probe: Probe) =>
    probe.status === "working" || probe.status === "blocked" || probe.approvalPending === true;
  const observedBareShell = (probe: Probe) => isBareLaneShell(probe) && probe.foreground?.[0]?.argvIncomplete !== true;
  let lane = seen;
  let intent = saved;
  let session = lane.session;
  const probeOnlyClose = async (ref: SessionRef): Promise<CloseCommit> => {
    try {
      if (mainBusy(await runtimesOf(deps).for(ref).probe(ref, { foregroundOnly: true }))) return hold(busy);
    } catch {
      // An unconfirmed terminal lane keeps the probe-only close, not a quiescence guarantee.
    }
    return recordClosed(deps, lane, basis);
  };
  try {
    if (initial) {
      if (!target) return recordClosed(deps, lane, basis);
      try {
        const probe = await runtimesOf(deps).for(target).probe(target);
        if (mainBusy(probe)) return hold(busy);
        session ??= probe.sessionId;
        // An unconfirmed terminal lane keeps the probe-only close. This is not a quiescence guarantee.
        if (!session || probe.pid === undefined) return recordClosed(deps, lane, basis);
      } catch {
        return recordClosed(deps, lane, basis);
      }
    }
    if (intent) {
      if (!boundTo(lane, intent)) return hold("prepared close is for a different pane, session, or epoch");
    } else {
      if (lane.hold?.outcome) return hold(`terminal intent is already ${lane.hold.outcome}`);
      if (!target || !session) return hold(unconfirmed);
      const state = await confirmedLaneState(deps, { ...lane, session }, target);
      if (!state) return initial ? probeOnlyClose(target) : hold(unconfirmed);
      if (state.agentStatus === "working") return hold(busy);
      if (target.runtime === "headless" && (state.agentStatus !== "idle" || state.sessionFile !== lane.sessionFile))
        return hold(unconfirmed);
      if (pendingDiscordLane(deps.config.stateDir, lane)) return hold("Discord messages are still pending");
      let process: ReturnType<typeof processIdentity>;
      try {
        process = processIdentity(deps, state.pid);
      } catch (error) {
        if (initial) return probeOnlyClose(target);
        throw error;
      }
      const prepared: NativeCloseIntent = {
        ...basis,
        ref: target,
        session,
        ...(lane.lifecycleEpoch === undefined ? {} : { epoch: lane.lifecycleEpoch }),
        openedAt: lane.openedAt,
        process,
      };
      const recorded = await deps.registry.transition(lane, (current) => {
        if (current.nativeCloseIntent || (current.session !== undefined && current.session !== session)) return null;
        const bound = { ...current, session: prepared.session };
        return boundTo(bound, prepared) ? { ...bound, nativeCloseIntent: prepared } : null;
      });
      if (!recorded) return { kind: "changed" };
      lane = recorded;
      intent = prepared;
    }

    const { ref } = intent;
    const runtime = runtimesOf(deps).for(ref);
    const headless = ref.runtime === "headless";
    if (headless && !(runtime instanceof HeadlessRuntime)) return hold(unconfirmed);
    const isPresent = async () =>
      headless ? (await runtime.probe(ref)).status !== "gone" : (await runtime.list()).some((s) => s.ref.id === ref.id);
    // An interrupted request may already have removed the target. Only its saved process proof can settle that close.
    if (!saved || (await isPresent())) {
      if (saved && pendingDiscordLane(deps.config.stateDir, lane)) return hold("Discord messages are still pending");
      const state = await confirmedLaneState(deps, lane, ref);
      if (!state) {
        const current = await runtime.probe(ref, { foregroundOnly: true });
        if (mainBusy(current)) return hold(busy);
        if (headless || !observedBareShell(current)) return hold(unconfirmed);
        const refusal = await processHold(deps, intent.process);
        if (refusal) return hold(refusal);
      } else {
        if (state.agentStatus === "working") return hold(busy);
        if (headless && (state.agentStatus !== "idle" || state.sessionFile !== lane.sessionFile))
          return hold(unconfirmed);
        const process = processIdentity(deps, state.pid);
        if (intent.process) {
          if (!sameProcess(intent.process, process))
            return hold("prepared close belongs to a different native process");
        } else {
          // An older prepared intent can acquire proof while its exact native pane is still live, never after it vanished.
          const recorded = await deps.registry.transition(lane, (current) => {
            const stored = current.nativeCloseIntent;
            return stored && boundTo(current, stored) && !stored.process
              ? { ...current, nativeCloseIntent: { ...stored, process } }
              : null;
          });
          if (!recorded) return { kind: "changed" };
          lane = recorded;
          intent = { ...intent, process };
        }
      }
      const current = await runtime.probe(ref, { foregroundOnly: true });
      if (mainBusy(current)) return hold(busy);
      if (
        state
          ? current.pid !== intent.process?.pid ||
            current.sessionId !== intent.session ||
            current.approvalPending !== false ||
            current.shellInFront !== false
          : !observedBareShell(current)
      )
        return hold(unconfirmed);
      if (headless) {
        const process = intent.process;
        if (
          !process ||
          current.agent !== "omp" ||
          current.status !== "idle" ||
          current.sessionFile !== lane.sessionFile
        )
          return hold(unconfirmed);
        if (!sameProcess(process, processIdentity(deps, process.pid)))
          return hold("prepared close belongs to a different native process");
        await runtime.close(ref, "session", intent.session);
      } else {
        await runtime.close(ref, intent.epoch === undefined && ref.container ? "container" : "session");
      }
      if (await isPresent()) return hold(`pane ${ref.id} is still present`);
    }
    const refusal = await processHold(deps, intent.process);
    if (refusal) return hold(refusal);
    return recordClosed(deps, lane, intent);
  } catch (error) {
    return hold(`native close unconfirmed: ${String(error)}`);
  }
};
