import { existsSync } from "node:fs";
import { type HeadlessObservation, HeadlessRuntime } from "../../../../src/runtime/headless.ts";

import { withDeliveryLock } from "./delivery-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { checkWaiting } from "./freshness-wait.ts";
import { notifyFreshness, rememberFreshness, sampleScreenReport } from "./freshness-notify.ts";
import { checkPausedLane } from "./pause.ts";
import { type Lane, sameLaneGeneration, sessionOf, statusOf } from "./registry.ts";
import { ReportError } from "./report-events.ts";
import { type Progress, Reports, reportScope } from "./reports.ts";
import { runtimesOf } from "./run.ts";
import { readScreen } from "./sessions.ts";
import { Supervision } from "./supervision.ts";
import type { SupervisionResult } from "./supervision-observe.ts";

export type SweepAct = {
  readonly kind:
    | "nudged"
    | "held"
    | "delivery-error"
    | "nudge-failed"
    | "posted"
    | "no-report"
    | "post-failed"
    | "pending-report"
    | "stale-report"
    | "unrelayed"
    | "working-while-paused"
    | "stalled"
    | "journal-error"
    | "blocked"
    | "wait-ended"
    | "warning"
    | "supervision-error";
  readonly lane: string;
  readonly detail: string;
};

const journalProblem = async (deps: FlowDeps, lane: Lane, acts: SweepAct[], error: unknown): Promise<void> => {
  // One corrupt journal skips its own lane, printed once per error, and never ends the sweep for the others.
  if (!(error instanceof ReportError)) throw error;
  const note = `journal-error|${error.message}`;
  if (note !== lane.lastFreshnessNote && (await rememberFreshness(deps, lane, { lastFreshnessNote: note }))) {
    acts.push({ kind: "journal-error", lane: lane.key, detail: error.message });
  }
};

export const freshnessTick = async (deps: FlowDeps, home: string): Promise<SweepAct[]> => {
  const acts: SweepAct[] = [];
  const now = deps.clock.now();
  const reports = new Reports(deps.config.stateDir, { memo: true });
  const supervision = new Supervision({ ...deps, stateDir: deps.config.stateDir, reports }, deps.config.supervision);
  for (const lane of await deps.registry.open()) {
    if (lane.nativeCloseIntent) continue;
    if (statusOf(lane) === "paused") {
      const checked = await checkPausedLane(deps, lane);
      // Reported once per working stretch (the note clears when the lane goes idle), so the lead can ask; it stays paused.
      if (
        checked &&
        checked.lane.lastFreshnessNote !== "working-while-paused" &&
        (await deps.registry.transition(checked.lane, (current) => ({
          ...current,
          lastFreshnessNote: "working-while-paused",
        })))
      ) {
        acts.push({
          kind: "working-while-paused",
          lane: lane.key,
          detail: "paused lane is working on two ticks; left paused (resume is cataly resume only)",
        });
      }
      continue;
    }
    const ref = sessionOf(lane);
    if (statusOf(lane) !== "working" || !ref) continue;
    // Only launched lanes report through the journal; an adopted lane keeps the screen path even if a record exists.
    let previous: Progress | null = null;
    let screen: string | null = null;
    let native: HeadlessObservation | undefined;
    let screenReport: string | null | undefined;
    let supervised: SupervisionResult | null = null;
    let supervisionError: string | undefined;
    let incompleteSample = false;
    const scope = reportScope(lane);
    if (lane.reportProtocol === "jsonl-v1") {
      try {
        previous = reports.read(lane.key, scope);
        if (ref.runtime !== "headless") screen = await readScreen(runtimesOf(deps), ref);
      } catch (error) {
        await journalProblem(deps, lane, acts, error);
        continue;
      }
      try {
        if (ref.runtime === "headless") {
          const runtime = runtimesOf(deps).for(ref);
          if (runtime instanceof HeadlessRuntime && lane.session && lane.sessionFile) {
            const seen = await runtime.observe(ref);
            if (
              seen.ref.runtime === ref.runtime &&
              seen.ref.id === ref.id &&
              seen.role === "lane" &&
              seen.detail === undefined &&
              (seen.status === "idle" || seen.status === "working" || seen.status === "blocked") &&
              seen.sessionId === lane.session &&
              seen.sessionFile === lane.sessionFile &&
              seen.pid !== undefined &&
              Number.isSafeInteger(seen.pid) &&
              seen.pid > 0
            )
              native = seen;
          }
        }
      } catch (error) {
        supervisionError = error instanceof Error ? error.message : String(error);
      }
      try {
        // A launched lane is supervised once its journal exists; without one there is no progress to judge.
        if (existsSync(reports.path(lane.key))) {
          const activeSince =
            native?.status === "working" && native.held === false && native.dialogs.length === 0
              ? native.activeSince
              : undefined;
          supervised = await supervision.sweep(lane, native === undefined ? screen : "", activeSince);
        }
        // Another sweep owns this lane through its effect baseline; don't replace its result with screen inference.
        if (supervised?.busy) continue;
        supervisionError = supervised?.observationError ?? supervisionError ?? supervised?.evidenceError;
        incompleteSample = supervised?.observationIncomplete === true;
      } catch (error) {
        supervisionError = error instanceof Error ? error.message : String(error);
      }
    } else if (ref.runtime !== "headless") {
      screenReport = await sampleScreenReport(deps, lane, ref, now);
    }
    await withDeliveryLock(deps, lane.key, async () => {
      // The screen and usage hook can outlive park/reopen; never apply them to the replacement lane.
      const current = await deps.registry.read(lane.key);
      if (
        !current ||
        current.nativeCloseIntent ||
        !sameLaneGeneration(lane, current) ||
        current.requestId !== lane.requestId ||
        current.runId !== lane.runId
      )
        return;
      // An uncommitted sweep must not apply its stale screen after another writer won.
      if (supervised?.enabled === false) return;
      const nativeStatus =
        native?.held === false &&
        native.dialogs.length === 0 &&
        (native.status === "idle" || native.status === "working")
          ? native.status
          : undefined;
      if (ref.runtime === "headless") {
        const live = sessionOf(current);
        if (
          live?.runtime !== ref.runtime ||
          live.id !== ref.id ||
          current.session !== lane.session ||
          current.sessionFile !== lane.sessionFile
        )
          return;
        const dialogs = native?.held === true ? native.dialogs.map(({ kind, id }) => `${kind} ${id}`).join(", ") : "";
        if ((dialogs || nativeStatus !== undefined) && current.lastNativeHold !== (dialogs || undefined)) {
          if (!(await rememberFreshness(deps, current, { lastNativeHold: dialogs || undefined }))) return;
          if (dialogs)
            acts.push({ kind: "blocked", lane: lane.key, detail: `native input held (${dialogs}); inspect the lane` });
        }
      }
      // Supervision is advisory: its failure is printed once per reason, and the lane's reports still flow.
      if (supervisionError !== undefined && supervisionError !== current.lastSupervisionError) {
        if (!(await rememberFreshness(deps, current, { lastSupervisionError: supervisionError }))) return;
        acts.push({ kind: "supervision-error", lane: lane.key, detail: supervisionError });
      } else if (
        supervisionError === undefined &&
        supervised?.enabled &&
        !incompleteSample &&
        current.lastSupervisionError
      ) {
        if (!(await rememberFreshness(deps, current, { lastSupervisionError: undefined }))) return;
      }
      for (const alert of supervised?.alertEvents ?? []) {
        acts.push({ ...alert, lane: lane.key });
      }
      const supervisedHung = Boolean(supervised?.hung || supervised?.heldHung);
      let progress: Progress | null = null;
      try {
        // Deliver durable reports even when this sample cannot support an inferred transition.
        if (incompleteSample || (ref.runtime === "headless" && nativeStatus === undefined))
          progress = reports.read(lane.key, scope);
        else if (screen !== null || nativeStatus !== undefined) {
          progress = reports.observe(
            lane.key,
            screen ?? "",
            now,
            deps.config.nudgeAfterMin * 60_000,
            supervisionError === undefined && !supervisedHung,
            scope,
            nativeStatus,
          );
        }
      } catch (error) {
        await journalProblem(deps, current, acts, error);
        return;
      }
      const waitAct = await checkWaiting(deps, lane, progress);
      if (waitAct) acts.push(waitAct);
      if (progress?.state === "stalled") {
        // A held evidence stall keeps its own alert, but its durable report still reaches the thread.
        if (!incompleteSample && previous?.state !== "stalled" && !supervisedHung) {
          acts.push({ kind: "stalled", lane: lane.key, detail: progress.lastEvent.text });
        }
        if (!supervisedHung) return;
        if (incompleteSample && supervisionError !== undefined && previous?.state === "stalled") return;
      }
      // An idle host without a goal may be a registered launch whose kickoff never landed.
      const nudgeObservation =
        nativeStatus !== undefined && native?.goal && native.goal.status !== "none" ? native : undefined;
      await notifyFreshness(deps, current, ref, progress, screenReport, now, home, acts, nudgeObservation);
    });
  }
  return acts;
};
