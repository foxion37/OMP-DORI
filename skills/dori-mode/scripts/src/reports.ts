import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LANE_KEY } from "./registry.ts";

export type ReportKind = "milestone" | "blocker" | "question" | "halted" | "done";
export type ProgressState = "running" | "blocked" | "halted" | "done" | "stalled";
type EventFields = {
  readonly key: string;
  readonly at: string;
  readonly text: string;
  readonly generation?: string;
};
export type Report = EventFields & {
  readonly type: "report";
  readonly kind: ReportKind;
  readonly owner?: string;
};
export type Activity = EventFields & {
  readonly type: "activity";
  readonly state: "running" | "stalled";
};
export type LaneEvent = Report | Activity | (EventFields & { readonly type: "reopen" });
type EventScope = { readonly generation: string | undefined };
export type Progress = {
  readonly state: ProgressState;
  readonly lastReport: Report | null;
  readonly lastEvent: LaneEvent;
};

export class ReportError extends Error {}

export const isReportKind = (value: unknown): value is ReportKind =>
  value === "milestone" || value === "blocker" || value === "question" || value === "halted" || value === "done";

// A question waits on the owner's answer, so it is blocked like a blocker: posted, never nudged.
export const reportState = (kind: ReportKind): ProgressState => {
  switch (kind) {
    case "milestone":
      return "running";
    case "blocker":
      return "blocked";
    case "question":
      return "blocked";
    case "halted":
      return "halted";
    case "done":
      return "done";
  }
};

// The printed line goes to terminals, so escape sequences and other control characters are dropped from it (a CR or
// newline becomes one space); the journal keeps the raw text.
export const reportLine = (report: Report): string =>
  `[REPORT] ${report.key} | ${report.kind} | ${Bun.stripANSI(report.text)
    .replace(/\s*[\r\n]+\s*/g, " ")
    // oxlint-disable-next-line no-control-regex -- the pattern deliberately matches control characters to reject or strip them
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")}`;

export const reportId = (report: Report): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        report.key,
        report.at,
        report.kind,
        report.text,
        report.owner ?? null,
        report.generation ?? null,
      ]),
    )
    .digest("hex");

export const parseEvent = (line: string, key: string): LaneEvent => {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== "object" ||
    value === null ||
    !("key" in value) ||
    value.key !== key ||
    !("at" in value) ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at)) ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    !("type" in value) ||
    ("generation" in value && typeof value.generation !== "string")
  ) {
    throw new ReportError(`invalid report record for ${key}`);
  }
  const common = {
    key,
    at: value.at,
    text: value.text,
    ...("generation" in value && typeof value.generation === "string" ? { generation: value.generation } : {}),
  };
  if (value.type === "reopen") return { ...common, type: "reopen" };
  if (value.type === "report" && "kind" in value && isReportKind(value.kind)) {
    if ("owner" in value && (typeof value.owner !== "string" || !value.owner.trim()))
      throw new ReportError(`invalid owner summary for ${key}`);
    return {
      ...common,
      type: "report",
      kind: value.kind,
      ...("owner" in value ? { owner: value.owner as string } : {}),
    };
  }
  if (value.type === "activity" && "state" in value && (value.state === "running" || value.state === "stalled")) {
    return { ...common, type: "activity", state: value.state };
  }
  throw new ReportError(`invalid report kind or activity state for ${key}`);
};

// One O_APPEND write per event: concurrent lane/lead writers cannot overwrite
// each other's state. The last event is the persisted progress state; no
// second mutable snapshot can race with this journal or registry done claims.
export class Reports {
  constructor(readonly stateDir: string) {}

  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new ReportError(`invalid lane key: ${key}`);
    return join(this.stateDir, "lanes", key, "reports.jsonl");
  }

  // With no scope, inspect the raw journal. An explicit undefined generation selects only legacy records.
  read(key: string, scope?: EventScope): Progress | null {
    const path = this.path(key);
    if (!existsSync(path)) return null;
    let progress: Progress | null = null;
    let lastReport: Report | null = null;
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      let event: LaneEvent;
      try {
        event = parseEvent(line, key);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof ReportError)) throw error;
        throw new ReportError(`${path}:${index + 1}: ${error.message}`);
      }
      if (scope && event.generation !== scope.generation) continue;
      if (event.type === "reopen") {
        lastReport = null;
        progress = { state: "running", lastReport, lastEvent: event };
      } else if (event.type === "report") {
        lastReport = event;
        progress = { state: reportState(event.kind), lastReport: event, lastEvent: event };
      } else if (!progress || progress.state === "running" || progress.state === "stalled") {
        progress = { state: event.state, lastReport, lastEvent: event };
      }
    }
    return progress;
  }

  append(event: LaneEvent): void {
    const path = this.path(event.key);
    parseEvent(JSON.stringify(event), event.key);
    const dir = join(this.stateDir, "lanes", event.key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only on creation; a directory made earlier with wider permissions is narrowed here.
    chmodSync(dir, 0o700);
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  report(key: string, kind: ReportKind, text: string, now: number, generation?: string, owner?: string): Report {
    const report: Report = {
      type: "report",
      key,
      kind,
      text: text.trim(),
      at: new Date(now).toISOString(),
      ...(generation === undefined ? {} : { generation }),
      ...(owner === undefined ? {} : { owner: owner.trim() }),
    };
    this.append(report);
    return report;
  }

  observe(
    key: string,
    screen: string,
    now: number,
    staleAfterMs: number,
    resumeOnWorking = true,
    scope?: EventScope,
  ): Progress | null {
    const progress = this.read(key, scope);
    if (!progress || (progress.state !== "running" && progress.state !== "stalled")) return progress;
    const visible = Bun.stripANSI(screen);
    const lastAt = (pattern: RegExp): number => {
      let at = -1;
      for (const match of visible.matchAll(pattern)) at = match.index;
      return at;
    };
    const workingAt = lastAt(/^\s*[^\w\n]*(?:Working|Running)\b/gim);
    const working = workingAt >= 0;
    // A failure counts only when no Working line follows it: an old error left on screen above a recovered lane is history.
    const failed =
      lastAt(
        /compaction (?:failed|failure|error)|failed to compact|error (?:during|in) compaction|auto-?compaction failed/gi,
      ) > workingAt;
    const idle = /^\s*[❯>]\s*$/m.test(visible);
    const stale = now - Date.parse(progress.lastReport?.at ?? progress.lastEvent.at) >= staleAfterMs;
    const state =
      failed || (idle && !working && stale) ? "stalled" : working && resumeOnWorking ? "running" : progress.state;
    if (state === progress.state) return progress;
    const { generation } = progress.lastEvent;
    const event: Activity = {
      type: "activity",
      key,
      at: new Date(now).toISOString(),
      state,
      ...(generation === undefined ? {} : { generation }),
      text: failed
        ? "compaction failed"
        : state === "stalled"
          ? "idle prompt without Working or a fresh report"
          : "Working activity resumed",
    };
    this.append(event);
    return this.read(key, scope);
  }
}
