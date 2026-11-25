import { join } from "node:path";
import { type BootLane, type Manifest, finished, readMonitorManifests } from "./boot-monitors.ts";
import type { CatalyConfig } from "./config.ts";
import type { DoctorCheck } from "./doctor-config.ts";
import { doctorProvenance } from "./doctor-provenance.ts";
import { monitorFilterFindings, monitorRuntimeFindings } from "./doctor-monitors.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { PaneState } from "./lane-state.ts";
import { leadAddress } from "./lead-ref.ts";
import { Lessons } from "./lessons.ts";
import { LANE_KEY } from "./registry.ts";
import { Reports, reportScope } from "./reports.ts";
import { runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";
import { parseSignal, SignalSyntaxError, splitDone } from "./signals-parse.ts";
import { Worklog } from "./worklog.ts";

export type DoctorFinding = {
  readonly check: DoctorCheck;
  readonly severity: "OK" | "INFO" | "WARN";
  readonly detail: string;
  readonly provenance?: string;
  readonly next?: string;
};

/** These local checks also power boot's advisory summary, without another runtime or network probe. */
export const doctorLocal = (
  config: CatalyConfig,
  lanes: readonly BootLane[],
  manifests: readonly Manifest[],
  repo?: string,
  liveSession?: string,
): DoctorFinding[] => {
  const findings = monitorFilterFindings(manifests, liveSession, config.freshness);
  const active = lanes.filter((lane) => !finished(lane));
  const launched = active.filter((lane) => lane.reportProtocol === "jsonl-v1");
  const adopted = active.filter((lane) => lane.reportProtocol !== "jsonl-v1");
  if (adopted.length)
    findings.push({
      check: "supervision",
      severity: "INFO",
      detail: `not supervised (adopted lanes): ${adopted.map((lane) => lane.key).join(", ")}; configured ceilings do not apply`,
    });
  const unbounded = launched.filter((lane) => {
    // Match Supervision.sweep: only this lane's effective limits can protect it.
    const limits = {
      ...config.supervision.defaults,
      ...config.supervision.lanes?.[lane.key],
      ...lane.budget,
    };
    return !(["wallMinutes", "tokens", "costUsd"] as const).some((name) => {
      const limit = limits[name];
      return typeof limit === "number" && Number.isFinite(limit) && limit >= 0;
    });
  });
  if (launched.length && (unbounded.length || !config.supervision.usageArgv?.length))
    findings.push({
      check: "supervision",
      severity: "WARN",
      detail: [
        unbounded.length
          ? `no configured ceilings for active lanes: ${unbounded.map((lane) => lane.key).join(", ")}`
          : "",
        !config.supervision.usageArgv?.length ? "no usage reader (cost is unknown, not zero)" : "",
      ]
        .filter(Boolean)
        .join("; "),
    });
  const repos = new Set(repo ? [repo.toLowerCase()] : []);
  let invalidDone = active.some((lane) => typeof lane.done !== "string");
  for (const lane of active.filter((lane) => typeof lane.done === "string")) {
    const parts = splitDone(lane.done);
    invalidDone ||= parts.length === 0;
    for (const part of parts) {
      try {
        const signal = parseSignal(part);
        if (signal.kind === "merged" || signal.kind === "closed") repos.add(signal.repo.toLowerCase());
      } catch (error) {
        if (!(error instanceof SignalSyntaxError)) throw error;
        invalidDone = true;
      }
    }
  }
  if (invalidDone)
    findings.push({
      check: "registry",
      severity: "WARN",
      detail: "open lane metadata has a missing or invalid Done signal",
    });
  for (const name of repos)
    if (!config.repoIdentities[name])
      findings.push({
        check: "repo-identities",
        severity: "WARN",
        detail: `${name} is not configured; verify-pr requires its author/committer identity`,
      });
  if (active.length && !repos.size && !Object.keys(config.repoIdentities).length)
    findings.push({
      check: "repo-identities",
      severity: "INFO",
      detail: "no repository identities configured; use --repo owner/repo to check a specific repository",
    });
  try {
    const worklog = new Worklog(config.stateDir).read();
    if (worklog.problems.length)
      findings.push({
        check: "worklog",
        severity: "WARN",
        detail: `damaged worklog records: ${worklog.problems.length}`,
      });
    if (active.length && !worklog.items.length)
      findings.push({
        check: "worklog",
        severity: "INFO",
        detail: `no worklog items with ${active.length} open lanes; cataly worklog records owner requests`,
      });
  } catch {
    findings.push({ check: "worklog", severity: "WARN", detail: "worklog is unreadable" });
  }
  try {
    const lessons = new Lessons(config.stateDir).read();
    if (lessons.problems.length)
      findings.push({
        check: "lessons",
        severity: "WARN",
        detail: `damaged lesson records: ${lessons.problems.length}`,
      });
    if (active.length && !lessons.lessons.length)
      findings.push({
        check: "lessons",
        severity: "INFO",
        detail: "no lessons recorded; cataly lesson can carry repository rules to future lanes",
      });
  } catch {
    findings.push({ check: "lessons", severity: "WARN", detail: "lessons are unreadable" });
  }
  return findings.filter((finding) => !config.doctor?.ignore?.includes(finding.check));
};

export const doctorCheck = async (
  deps: Pick<FlowDeps, "run" | "registry" | "config" | "clock" | "rts" | "env">,
  repo?: string,
) => {
  const { config } = deps;
  const findings: DoctorFinding[] = [];
  const lanes: BootLane[] = [];
  try {
    const scanned = await deps.registry.scan();
    const reports = new Reports(config.stateDir);
    let invalidKeys = 0;
    for (const lane of scanned.lanes) {
      if (!LANE_KEY.test(lane.key)) {
        invalidKeys++;
        continue;
      }
      if (finished(lane) || lane.reportProtocol !== "jsonl-v1") {
        lanes.push(lane);
        continue;
      }
      try {
        lanes.push({ ...lane, reportState: reports.read(lane.key, reportScope(lane))?.state });
      } catch {
        findings.push({
          check: "registry",
          severity: "WARN",
          detail: "a lane journal is unreadable; completion is unverified",
        });
        lanes.push(lane);
      }
    }
    const unreadable = scanned.unreadable.length;
    findings.push({
      check: "registry",
      severity: unreadable || invalidKeys ? "WARN" : "OK",
      detail: `lanes=${lanes.length} unreadable=${unreadable}${invalidKeys ? ` invalidKeys=${invalidKeys}` : ""}`,
    });
  } catch {
    findings.push({ check: "registry", severity: "WARN", detail: "registry is unreadable" });
  }
  const env = deps.env ?? process.env;
  const rts = runtimesOf(deps);
  const target = leadAddress(config, env);
  const { manifests, errors } = readMonitorManifests(join(config.stateDir, "monitors"));
  if (errors.length)
    findings.push({
      check: "monitors",
      severity: "WARN",
      detail: `unreadable monitor metadata locations: ${errors.length}`,
    });
  let lead: PaneState | null = null;
  if (!rts.choice)
    findings.push({
      check: "runtime",
      severity: "WARN",
      detail: `runtime selection unavailable: ${rts.failure?.message ?? "no runtime chosen"}`,
    });
  if ("reason" in target)
    findings.push({
      check: "runtime",
      severity: target.reason === "unconfigured" && rts.choice?.kind === "headless" ? "INFO" : "WARN",
      detail: `lead ${target.reason}; liveness unverified`,
    });
  else {
    try {
      const { ref } = target;
      lead = await trustedPaneState(deps.run, config.stateDir, ref, rts);
      if (lead?.role !== "cataly") lead = null;
      const agentStatus = lead?.agentStatus;
      const status = agentStatus === "idle" || agentStatus === "working" ? agentStatus : "unknown";
      const approval = lead?.approvalPending;
      const approvalPending = typeof approval === "boolean" ? approval : "unknown";
      findings.push({
        check: "runtime",
        severity: lead ? "OK" : "WARN",
        detail:
          ref.runtime +
          " lead=" +
          JSON.stringify(config.leadPane || ref.id) +
          (lead
            ? ` role=cataly status=${status} approvalPending=${approvalPending}`
            : " has no trusted live Cataly record"),
      });
    } catch {
      findings.push({
        check: "runtime",
        severity: "WARN",
        detail: "lead runtime inspection failed; liveness unverified",
      });
    }
  }
  findings.push(...doctorLocal(config, lanes, manifests, repo, lead?.sessionId));
  findings.push(...monitorRuntimeFindings(config.stateDir, manifests, lead, deps.clock.now()));
  findings.push(...(await doctorProvenance(deps, lanes, lead)));
  const visible = findings.filter((finding) => !config.doctor?.ignore?.includes(finding.check));
  const warnings = visible.filter((finding) => finding.severity === "WARN").length;
  return { findings: visible, warnings, ignored: config.doctor?.ignore ?? [], exitCode: warnings ? 1 : 0 };
};
