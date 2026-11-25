import { readRuntimeHealth } from "../../../../src/update/deployment-monitor-receipts.ts";
import { processIdentity, underProcess } from "../../../../src/update/deployment-process.ts";
import type { Manifest } from "./boot-monitors.ts";
import type { DoctorFinding } from "./doctor.ts";
import type { SweepAct } from "./freshness.ts";
import type { FreshnessPolicy } from "./freshness-policy.ts";
import type { PaneState } from "./lane-state.ts";
import { monitorPresetFor, type monitorPresets } from "./monitor-presets.ts";

type ProbeEvent =
  Exclude<(typeof monitorPresets)[number], { name: "freshness" }>["events"][number] | Uppercase<SweepAct["kind"]>;

// Sample the emitted line shape, not a synthetic suffix. An empty payload means the emitter prints just the label.
const probePayloads: Partial<Record<string, string>> = {
  LANE_WATCH_READY: "",
  LANE_WATCH_WARN: "Error: registry is unreadable",
  LANE_WATCH_ERROR:
    "integration ENOSPC: delivery state write failed; inspect the lane lifecycle, cataly tell integration --status and the original session; do not resend",
  LANE_NOTIFY_HELD:
    "integration TELL_HELD integration delivery=held: request=00000000-0000-4000-8000-000000000000 is uncertain; this message was not sent; inspect cataly tell integration --status, then --resolve 00000000-0000-4000-8000-000000000000 --note REASON to end only its hold",
  LANE_NOTIFY_UNCONFIRMED:
    "integration TELL_UNCONFIRMED integration delivery=unconfirmed: request=00000000-0000-4000-8000-000000000000; the runtime did not confirm delivery; later messages are held; do not resend",
  LANE_DONE_CLAIMED: "integration w1:p2 checks passed",
  LANE_CHANGED: "integration moved on while this ran (now working, was done-claimed); verification not recorded",
  LANE_NOT_DONE: "integration pending checks",
  LANE_CLOSED: 'integration {"checks":[],"note":"Done: checks passed","cleanup":[]}',
  LANE_HELD: "integration a message to the lane is in flight (delivery); retried next tick",
  LANE_QUEUE_READY: "integration; live checks run on explicit cataly queue start integration",
  LANE_QUEUE_HELD: "integration predecessor(working)",
  LANE_QUEUE_WARN: "integration.json: invalid queue record: integration",
  DEAD_PANE: "w1:p2",
  UNRECOGNISED_PANE: "w1:p2 dead-panes: no alive status and no dead marker for 3 ticks",
  HOST_GUARD_READY: "",
  "HOST_GUARD ALERT": "load 20 > 16",
  "HOST_GUARD CLEAR": "load 2, memory free 46%, disk free 50 GB, swap free 4.0 GB",
  "HOST_GUARD COMPUTE_READY": "load 2 < 8",
  "HOST_GUARD COMPUTE_BUSY": "load 10",
  NUDGED: "integration 15 min silent, delivery delivered",
  HELD: "integration TELL_UNCONFIRMED integration delivery=unconfirmed: request=00000000-0000-4000-8000-000000000000; the runtime did not confirm delivery; later messages are held; do not resend",
  "DELIVERY-ERROR":
    "integration ENOSPC: delivery state write failed; inspect cataly tell integration --status and the original session; do not resend",
  "NUDGE-FAILED": "integration idle-only delivery failed; left unnudged",
  POSTED: "integration Progress (from the lane's last report): checks passed",
  "POST-FAILED": "integration thread hook failed (exit 1)",
  "NO-REPORT": "integration report journal has no report",
  "PENDING-REPORT": "integration a new [REPORT] line; posting once it holds on the next tick",
  "STALE-REPORT": "integration the last [REPORT] line was already posted",
  UNRELAYED: "integration report kind requires the lead to relay it",
  STALLED: "integration no progress reported",
  "JOURNAL-ERROR": "integration malformed report journal",
  "WORKING-WHILE-PAUSED": "integration paused lane is working on two ticks; left paused (resume is cataly resume only)",
  BLOCKED: "integration wallMinutes ceiling reached (30)",
  WARNING: "integration tokens ceiling cannot be checked: usage unavailable",
  "SUPERVISION-ERROR": "integration usage probe failed",
  PR_FEEDBACK: "example/project#12 lane=integration thread=- kind=review by=reviewer - | Check edge cases.",
  PR_CI_FAIL: "example/project#12 lane=integration thread=- conclusion=failure head=123abcd - | unit tests",
  PR_HEAD_MOVED: "example/project#12 lane=integration thread=- by=contributor +1 123abcd..456abcd -",
  PR_MERGED: "example/project#12 lane=integration thread=- sha=0123456789abcdef0123456789abcdef01234567",
  PR_CLOSED: "example/project#12 lane=integration thread=- unmerged",
  PR_REOPENED: "example/project#12 lane=integration thread=-",
  PR_WATCH_WARN: "run GitHub request failed",
  "WAIT-ENDED": "wait-ended",
  WARN: "pane list is unreadable",
} satisfies Record<ProbeEvent, string>;

export const monitorFilterFindings = (
  manifests: readonly Manifest[],
  liveSession?: string,
  freshness?: FreshnessPolicy,
): DoctorFinding[] => {
  const findings: DoctorFinding[] = [];
  for (const manifest of manifests) {
    const severity = manifest.data.sessionId === liveSession ? "WARN" : "INFO";
    for (const monitor of manifest.data.monitors) {
      const preset = monitorPresetFor(monitor.argv);
      if (!preset) continue;
      const label = `${JSON.stringify(monitor.name)}${severity === "INFO" ? ` (recorded session ${JSON.stringify(manifest.data.sessionId)}; liveness unverified)` : ""}`;
      try {
        const filter = new RegExp(monitor.filter ?? ".");
        const missing = preset.events.filter((event) => {
          if (preset.name === "freshness") {
            if (event === "NUDGE-FAILED" && freshness?.nudge !== "idle-only") return false;
            if (event === "UNRELAYED" && freshness?.postRaw !== false && freshness?.autoPostKinds === undefined)
              return false;
          }
          const payload = probePayloads[event];
          return payload === undefined || !filter.test(payload ? `${event} ${payload}` : event);
        });
        if (missing.length)
          findings.push({
            check: "monitor-filter",
            severity,
            detail:
              label +
              " misses probes: " +
              missing.join(" ") +
              "; inspect cataly monitor-presets " +
              preset.name +
              " in the owner session",
          });
      } catch {
        findings.push({
          check: "monitor-filter",
          severity,
          detail: `${label} has an invalid regular expression`,
        });
      }
    }
  }
  return findings;
};

/** Desired intent is not liveness; only a fresh receipt bound to the trusted lead can attest a child. */
export const monitorRuntimeFindings = (
  stateDir: string,
  manifests: readonly Manifest[],
  lead: PaneState | null,
  now: number,
): DoctorFinding[] => {
  const wanted = manifests.filter((manifest) => manifest.data.monitors.length);
  const findings: DoctorFinding[] = [];
  for (const manifest of wanted) {
    if (!lead || manifest.data.sessionId !== lead.sessionId) {
      findings.push({
        check: "monitor-runtime",
        severity: "INFO",
        detail:
          JSON.stringify(manifest.data.sessionId) +
          " has " +
          manifest.data.monitors.length +
          " recorded monitors; liveness unverified (not the current trusted lead)",
      });
      continue;
    }
    try {
      const health = readRuntimeHealth({ stateDir, pane: lead.paneId, sessionId: lead.sessionId });
      if (
        !health ||
        health.pid !== lead.pid ||
        health.startedAt !== lead.startedAt ||
        now - Date.parse(health.updatedAt) > 5_000 ||
        Date.parse(health.updatedAt) > now + 1_000
      ) {
        findings.push({
          check: "monitor-runtime",
          severity: "WARN",
          detail: "lead monitor health is absent, stale or belongs to another process; liveness unverified",
        });
        continue;
      }
      for (const spec of manifest.data.monitors) {
        try {
          const running = health.monitors.find((entry) => entry && entry.name === spec.name);
          const identity =
            running && Number.isSafeInteger(running.pid) && running.pid > 0 ? processIdentity(running.pid) : undefined;
          const live =
            running &&
            identity &&
            running.pid !== lead.pid &&
            identity.startTicks === running.startTicks &&
            underProcess(running.pid, lead.pid);
          const matches =
            live &&
            JSON.stringify(running.argv) === JSON.stringify(spec.argv) &&
            running.cwd === spec.cwd &&
            running.restart === spec.restart &&
            typeof running.filter === "string" &&
            new RegExp(running.filter).source === new RegExp(spec.filter ?? ".").source;
          findings.push({
            check: "monitor-runtime",
            severity: matches ? "OK" : "WARN",
            detail:
              JSON.stringify(spec.name) +
              (matches
                ? " live with recorded spec"
                : " recorded but no matching live child; inspect in the owner session (no automatic restart)"),
          });
        } catch {
          findings.push({
            check: "monitor-runtime",
            severity: "WARN",
            detail: `${JSON.stringify(spec.name)} has an invalid or unreadable process receipt; liveness unverified`,
          });
        }
      }
    } catch {
      findings.push({
        check: "monitor-runtime",
        severity: "WARN",
        detail: "lead monitor health is unreadable or invalid; liveness unverified",
      });
    }
  }
  return findings;
};
