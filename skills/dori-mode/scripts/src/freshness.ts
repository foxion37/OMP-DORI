import { existsSync } from "node:fs";

import { withDeliveryLock } from "./delivery-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { notifyFreshness, rememberFreshness, sampleLegacyReport } from "./freshness-notify.ts";
import { checkPausedLane } from "./pause.ts";
import { type Lane, sameLaneGeneration, sessionOf, statusOf } from "./registry.ts";
import { type Progress, ReportError, Reports } from "./reports.ts";
import { runtimesOf } from "./run.ts";
import { readScreen } from "./sessions.ts";
import { Supervision, type SupervisionResult } from "./supervision.ts";

export type SweepAct = {
  readonly kind:
    | "nudged"
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
  const reports = new Reports(deps.config.stateDir);
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
          detail: "paused lane is working on two ticks; left paused (resume is dori resume only)",
        });
      }
      continue;
    }
    const ref = sessionOf(lane);
    if (statusOf(lane) !== "working" || !ref) continue;
    // Only launched lanes report through the journal; an adopted lane keeps the screen path even if a record exists.
    let previous: Progress | null = null;
    let screen: string | null = null;
    let legacyReport: string | null | undefined;
    let supervised: SupervisionResult | null = null;
    let supervisionError: string | undefined;
    const scope = { generation: lane.lifecycleEpoch };
    if (lane.reportProtocol === "jsonl-v1") {
      try {
        previous = reports.read(lane.key, scope);
        screen = await readScreen(runtimesOf(deps), ref);
      } catch (error) {
        await journalProblem(deps, lane, acts, error);
        continue;
      }
      try {
        // A launched lane is supervised once its journal exists; without one there is no progress to judge.
        if (existsSync(reports.path(lane.key))) supervised = await supervision.sweep(lane, screen);
      } catch (error) {
        supervisionError = error instanceof Error ? error.message : String(error);
      }
    } else {
      legacyReport = await sampleLegacyReport(deps, lane, ref, now);
    }
    await withDeliveryLock(deps, lane.key, async () => {
      // The screen and usage hook can outlive park/reopen; never apply them to the replacement lane.
      const current = await deps.registry.read(lane.key);
      if (!current || current.nativeCloseIntent || !sameLaneGeneration(lane, current)) return;
      // Supervision is advisory: its failure is printed once per reason, and the lane's reports still flow.
      if (supervisionError !== undefined && supervisionError !== current.lastSupervisionError) {
        if (!(await rememberFreshness(deps, current, { lastSupervisionError: supervisionError }))) return;
        acts.push({ kind: "supervision-error", lane: lane.key, detail: supervisionError });
      } else if (supervised?.enabled && current.lastSupervisionError) {
        if (!(await rememberFreshness(deps, current, { lastSupervisionError: undefined }))) return;
      }
      for (const detail of supervised?.alerts ?? []) {
        acts.push({
          kind: supervised?.state === "blocked" ? "blocked" : supervised?.state === "stalled" ? "stalled" : "warning",
          lane: lane.key,
          detail,
        });
      }
      let progress: Progress | null = null;
      if (screen !== null) {
        try {
          progress = reports.observe(
            lane.key,
            screen,
            now,
            deps.config.nudgeAfterMin * 60_000,
            !supervised?.hung,
            scope,
          );
        } catch (error) {
          await journalProblem(deps, current, acts, error);
          return;
        }
      }
      if (progress?.state === "stalled") {
        // Only supervision's own hung result replaces the stall line; a usage warning is not a stall.
        if (previous?.state !== "stalled" && !supervised?.hung) {
          acts.push({ kind: "stalled", lane: lane.key, detail: progress.lastEvent.text });
        }
        return;
      }
      await notifyFreshness(deps, current, ref, progress, legacyReport, now, home, acts);
    });
  }
  return acts;
};
