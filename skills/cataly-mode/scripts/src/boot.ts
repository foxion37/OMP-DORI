import { join } from "node:path";
import { configPath } from "./config.ts";
import type { Decisions } from "./decisions.ts";
import { decisionBootLines } from "./decisions-render.ts";
import { doctorLocal } from "./doctor.ts";
import type { FlowDeps } from "./done-flow.ts";
import { holdLines } from "./holds.ts";
import { shellQuote } from "./launch-footer.ts";
import { leadAddress } from "./lead-ref.ts";
import type { Slack } from "./messenger/slack.ts";
import { bootSessions } from "./boot-checks.ts";
import { type BootLane, monitorCleanup, readMonitorManifests } from "./boot-monitors.ts";
import { type Lane, statusOf } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { ReportError } from "./report-events.ts";
import { type Reports, reportScope } from "./reports.ts";
import { slackToken, TokenFileError, tokenFileNotice } from "./slack-token.ts";
import type { Worklog } from "./worklog.ts";
import { worklogLines } from "./worklog-render.ts";

export type SlackCheck = () => Promise<{
  readonly userId: string;
  readonly teamId: string;
  readonly notice?: string;
} | null>;
export type BootDeps = Pick<FlowDeps, "run" | "registry" | "config" | "clock" | "rts" | "env"> & {
  readonly reports: Reports;
  readonly worklog: Worklog;
  readonly decisions?: Decisions;
  /** null when no Slack token is configured; boot then skips the check. */
  readonly slack: SlackCheck;
  /** How long the Slack step may take; withBackoff alone can retry for minutes. */
  readonly slackDeadlineMs?: number;
};

/** The boot Slack step: auth.test through the given client, or null (skipped) when no token is configured. */
export const slackAuthCheck =
  (slack: Pick<Slack, "call"> | null): SlackCheck =>
  async () => {
    if (!slack) return null;
    const auth = await slack.call("auth.test", {});
    // A success without both ids proves nothing about the account, as in `inbound`.
    if (
      typeof auth["user_id"] !== "string" ||
      !auth["user_id"] ||
      typeof auth["team_id"] !== "string" ||
      !auth["team_id"]
    )
      throw new Error("auth.test returned no user_id or team_id");
    return { userId: auth["user_id"], teamId: auth["team_id"] };
  };

/** Read the Slack token during its check, so a token-file error cannot interrupt the other boot checks. */
export const envSlackCheck =
  (
    client: (token: string) => Pick<Slack, "call">,
    env: Readonly<Record<string, string | undefined>> = process.env,
    platform: string = process.platform,
    configFile: string = configPath(),
  ): SlackCheck =>
  async () => {
    // A token file outside this home is refused here too, so the lead sees it at boot and not only at a launch.
    // One resolution: the string home-checked is the string read (tokenFileToRead).
    const token = slackToken(env, platform, process.getuid?.(), configFile);
    const auth = await slackAuthCheck(token ? client(token) : null)();
    const notice = tokenFileNotice(env, platform);
    return auth && notice ? { ...auth, notice } : auth;
  };

/**
 * Read-only recovery check after a restart or compaction: messenger auth, lanes whose pane vanished, panes no lane
 * owns, each lane's journal state, and persistent watches left on finished lanes. It changes nothing: no registry
 * write, no relaunch, no stopped watch. Exit 1 when any input could not be read, on drift, or on a config warning.
 */
export const bootCheck = async (deps: BootDeps): Promise<{ exitCode: number; lines: string[] }> => {
  const lines: string[] = [];
  let failed = false;
  const rts = runtimesOf(deps);
  const env = deps.env ?? process.env;
  const target = leadAddress(deps.config, env);
  const leadRef = "ref" in target ? target.ref : undefined;
  if ("reason" in target && target.reason !== "unconfigured") {
    failed = true;
    lines.push(`LEAD ${target.reason}; liveness unverified`);
  }
  if (rts.choice) lines.push(`RUNTIME ${rts.choice.kind} (from ${rts.choice.source})`);
  else {
    failed = true;
    lines.push(`RUNTIME unavailable: ${rts.failure?.message ?? "no runtime chosen"}`);
  }
  const lanes: BootLane[] = [];
  const journals: string[] = [];
  // An unreadable lane file, or a lanes path that cannot be listed, is named; the other lanes and checks still run.
  let registered: Lane[] = [];
  try {
    const scanned = await deps.registry.scan();
    registered = scanned.lanes;
    for (const path of scanned.unreadable) {
      failed = true;
      lines.push(`REGISTRY unreadable ${shellQuote(path)}`);
    }
  } catch {
    failed = true;
    lines.push(`REGISTRY unreadable ${shellQuote(deps.registry.dir)}`);
  }
  for (const lane of registered.sort((a, b) => a.key.localeCompare(b.key))) {
    // Only launched lanes report through the journal, as in freshness; an adopted lane's records are not its state.
    if (lane.reportProtocol !== "jsonl-v1") {
      lanes.push(lane);
      continue;
    }
    try {
      const progress = deps.reports.read(lane.key, reportScope(lane));
      lanes.push({ ...lane, reportState: progress?.state });
      // The launch's activity record and screen-derived stalls are written by cataly, not the lane: only a report is one.
      const report = progress?.lastReport;
      if (report)
        journals.push(
          `REPORT ${lane.key} kind=${report.kind} at=${report.at} state=${progress.state} registryStatus=${statusOf(lane)}`,
        );
      else if (progress)
        journals.push(
          `NO-REPORT ${lane.key} state=${progress.state} registryStatus=${statusOf(lane)} (journal holds harness activity only)`,
        );
      else journals.push(`NO-REPORT ${lane.key} registryStatus=${statusOf(lane)} (no journal)`);
    } catch (e) {
      // Any unreadable journal is that lane's error; the other lanes are still checked. The message can carry a local
      // path, so only the error kind is printed.
      failed = true;
      const code = (e as NodeJS.ErrnoException | null)?.code;
      const kind =
        e instanceof ReportError
          ? "invalid-journal"
          : typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
            ? code
            : "unreadable";
      journals.push(`JOURNAL-ERROR ${lane.key} kind=${kind}`);
      lanes.push(lane);
    }
  }
  const runtime = await bootSessions(deps.run, deps.config, rts, registered, lanes, leadRef);
  lines.push(...runtime.lines);
  if (runtime.failed) failed = true;
  lines.push(...holdLines(registered));
  lines.push(...journals);
  // The lead's open requests, each with its Next line, so a compacted lead resumes from the record, not from memory.
  try {
    const read = deps.worklog.read();
    lines.push(...worklogLines(read.items));
    for (const problem of read.problems) {
      failed = true;
      lines.push(`WORKLOG damaged ${problem}`);
    }
    // A next or note that raced a close was ignored; it is worth naming but leaves the record whole.
    for (const warning of read.warnings) lines.push(`WORKLOG warning ${warning}`);
  } catch {
    failed = true;
    lines.push(`WORKLOG unreadable ${shellQuote(deps.worklog.path)}`);
  }
  const decisions = deps.decisions ? decisionBootLines(deps.decisions, deps.clock.now()) : undefined;
  lines.push(...(decisions?.lines ?? []));
  if (decisions?.failed) failed = true;
  const { manifests, errors } = readMonitorManifests(join(deps.config.stateDir, "monitors"));
  for (const path of errors) {
    failed = true;
    lines.push(`MONITORS unreadable ${shellQuote(path)}`);
  }
  lines.push(
    `DOCTOR warn=${doctorLocal(deps.config, lanes, manifests).filter((finding) => finding.severity === "WARN").length} ignored=${deps.config.doctor?.ignore?.join(",") || "none"} (local advisory checks; run cataly doctor for details)`,
  );
  const cleanup = monitorCleanup(lanes, manifests);
  const now = deps.clock.now();
  lines.push(`MONITORS cleanupCandidates=${cleanup.length} (from metadata; liveness unverified)`);
  for (const item of cleanup) {
    lines.push(
      `CLEANUP ${item.lanes.join(",")} match=${item.match.join(",")} ownerSession=${item.sessionId} metadata=${shellQuote(item.metadata)}`,
    );
    lines.push(`STOP in the owner session only: ${item.stop}`);
  }
  const scheduled = await (await import("./schedule-view.ts")).scheduleBoot(deps.config.stateDir, deps.run, now);
  lines.push(...scheduled.lines);
  if (scheduled.failed) failed = true;
  // The network step runs last, after every local check, and gives up at a short deadline.
  const deadlineMs = deps.slackDeadlineMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const auth = await Promise.race([
      deps.slack(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), deadlineMs);
      }),
    ]);
    if (auth === "timeout") {
      failed = true;
      lines.push(`SLACK auth.test timed out after ${deadlineMs} ms`);
    } else
      lines.push(
        auth
          ? `SLACK authenticated user=${auth.userId} team=${auth.teamId} (auth.test only; inbox delivery unverified)`
          : "SLACK skipped (CATALY_SLACK_TOKEN not set)",
      );
    if (auth && auth !== "timeout" && auth.notice) lines.push(`SLACK token-file: ${auth.notice}`);
  } catch (e) {
    failed = true;
    // A token file error names the path, never the value; any other error may carry provider text, so it is not shown.
    lines.push(e instanceof TokenFileError ? `SLACK token-file: ${e.message}` : "SLACK auth failed");
  } finally {
    clearTimeout(timer);
  }
  lines.push(`BOOT ${failed ? "incomplete" : "checked"} read-only; nothing restarted, written or stopped`);
  return { exitCode: failed ? 1 : 0, lines };
};
