import type { Runtimes } from "../../../../src/runtime/registry.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { anchoredReportLine, scrubForThread } from "./freshness-report.ts";
import type { SweepAct } from "./freshness.ts";
import { type Lane, sameLaneGeneration, sessionOf } from "./registry.ts";
import { isReportKind, type Progress, reportId, reportLine } from "./reports.ts";
import { runtimesOf } from "./run.ts";
import { readScreen, sendVerified } from "./sessions.ts";

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

/** Update only the generation that produced this sweep, without overwriting other registry fields. */
export const rememberFreshness = (deps: FlowDeps, lane: Lane, patch: Partial<Lane>) =>
  deps.registry.transition(lane, (current) => ({ ...current, ...patch }));

// Equality admits a new report written in the same millisecond as the previous auto-post.
const mayAutoPost = (lane: Lane, heard: number): boolean => (lane.lastAutoReplyAt ?? 0) <= heard;

const mayInspectReport = (deps: FlowDeps, lane: Lane, now: number, heard: number): boolean => {
  const policy = deps.config.freshness;
  const hasPostingPolicy = policy?.postRaw === false || policy?.autoPostKinds !== undefined;
  if (!deps.config.hooks.threadReply && !hasPostingPolicy) return false;
  const threadActivity = Math.max(lastHeard(lane), lane.lastAutoReplyAt ?? 0, lane.lastRelayedAt ?? 0);
  const threadQuietMin = Math.round((now - threadActivity) / 60_000);
  // Opt-in policies can notice held reports even while the legacy auto-post gate is closed.
  return (
    threadQuietMin >= deps.config.postAfterMin &&
    lane.thread !== "none" &&
    (hasPostingPolicy || mayAutoPost(lane, heard))
  );
};

export const sampleLegacyReport = async (deps: FlowDeps, lane: Lane, ref: SessionRef, now: number) => {
  if (!mayInspectReport(deps, lane, now, lastHeard(lane))) return undefined;
  return anchoredReportLine(await readScreen(runtimesOf(deps), ref, 200), lane.key);
};

const trustedIdle = async (runtimes: Runtimes, ref: SessionRef): Promise<boolean> => {
  const observed = await runtimes
    .for(ref)
    .probe(ref)
    .catch(() => undefined);
  return observed?.status === "idle" && !observed.shellInFront && !observed.approvalPending;
};

const sameReceipt = (a: Lane, b: Lane): boolean =>
  a.lastPostedReportId === b.lastPostedReportId &&
  a.lastPostedReport === b.lastPostedReport &&
  a.lastPostedReportOwner === b.lastPostedReportOwner &&
  a.lastRelayedAt === b.lastRelayedAt;

/** Called under the delivery lock, after the observed lane has been revalidated. */
export const notifyFreshness = async (
  deps: FlowDeps,
  lane: Lane,
  ref: SessionRef,
  progress: Progress | null,
  legacyReport: string | null | undefined,
  now: number,
  home: string,
  acts: SweepAct[],
): Promise<void> => {
  // A blocker, question, halted or done lane is not nudged, but its report still reaches the thread.
  const running = !progress || progress.state === "running";
  const heard = Math.max(lastHeard(lane), progress?.lastReport ? Date.parse(progress.lastReport.at) : 0);
  const silentMin = Math.round((now - heard) / 60_000);
  let current = lane;
  const policy = deps.config.freshness;
  const idleOnly = policy?.nudge === "idle-only";
  const runtimes = runtimesOf(deps);
  if (
    running &&
    silentMin >= deps.config.nudgeAfterMin &&
    (current.lastNudgeAt ?? 0) < heard &&
    (!idleOnly || (await trustedIdle(runtimes, ref)))
  ) {
    const delivery = await sendVerified(
      runtimes,
      deps.clock,
      ref,
      `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`,
      idleOnly ? "idle" : undefined,
      lane.lifecycleEpoch ? lane.session : undefined,
      idleOnly,
    );
    const failure = idleOnly && delivery === "failed" ? `nudge-failed|${heard}` : undefined;
    // Record the completed attempt on its own pane even if a claim arrived during delivery.
    const nudged = await deps.registry.update(lane.key, (stored) => {
      if (!stored || stored.openedAt !== lane.openedAt || stored.lifecycleEpoch !== lane.lifecycleEpoch) return null;
      const actual = sessionOf(stored);
      if (actual?.id !== ref.id || actual.runtime !== ref.runtime || stored.session !== lane.session) return null;
      return failure
        ? { ...stored, lastNudgeFailure: failure }
        : { ...stored, lastNudgeAt: now, lastNudgeFailure: undefined };
    });
    if (!nudged) return;
    current = nudged;
    if (!failure)
      acts.push({ kind: "nudged", lane: lane.key, detail: `${silentMin} min silent, delivery ${delivery}` });
    else if (failure !== lane.lastNudgeFailure)
      acts.push({ kind: "nudge-failed", lane: lane.key, detail: "idle-only delivery failed; left unnudged" });
    if (!sameLaneGeneration(lane, current)) return;
  }
  const hook = deps.config.hooks.threadReply;
  if (mayInspectReport(deps, current, now, heard)) {
    // A journal report is durable, so it skips the two-tick hold; a screen-scraped line counts only once it is still
    // there on the next tick (the two reads are a full loop interval apart).
    const entry = progress?.lastReport;
    const fromJournal = entry ? reportLine(entry) : null;
    const id = entry ? reportId(entry) : undefined;
    const owner = entry?.owner;
    const ownerLine = entry && owner ? reportLine({ ...entry, text: owner }) : null;
    const report = fromJournal ?? legacyReport;
    const lastSeenReport = report ?? undefined;
    const kind = entry?.kind ?? report?.split("|")[1]?.trim();
    const allowAutomatic = mayAutoPost(current, heard);
    if (!allowAutomatic && !report) {
      if (legacyReport === null && current.lastSeenReport !== undefined) {
        await rememberFreshness(deps, lane, { lastSeenReport: undefined, lastFreshnessNote: undefined });
      }
      return;
    }
    let hold: { kind: SweepAct["kind"]; detail: string } | null = null;
    if (!report)
      hold = {
        kind: "no-report",
        detail: lane.reportProtocol === "jsonl-v1" ? "report journal has no report" : "pane has no [REPORT] line",
      };
    else if (!fromJournal && report !== current.lastSeenReport)
      hold = { kind: "pending-report", detail: "a new [REPORT] line; posting once it holds on the next tick" };
    else if (
      (id !== undefined && id === current.lastPostedReportId) ||
      (report === current.lastPostedReport && owner === current.lastPostedReportOwner)
    ) {
      if (!allowAutomatic) return;
      hold = { kind: "stale-report", detail: "the last [REPORT] line was already posted or relayed" };
    } else if (policy?.autoPostKinds && (!isReportKind(kind) || !policy.autoPostKinds.includes(kind)))
      hold = { kind: "unrelayed", detail: "report kind requires the lead to relay it" };
    else if (policy?.postRaw === false && (!ownerLine || !scrubForThread(ownerLine, home)))
      hold = { kind: "unrelayed", detail: "report needs an owner summary or the lead to relay it" };
    else if (!hook) hold = { kind: "unrelayed", detail: "no threadReply hook; the lead must relay this report" };
    if (hold) {
      const witness = hold.kind === "unrelayed" ? (id ?? report) : report;
      const note = `${hold.kind}|${hold.detail}|${witness ?? ""}`;
      const recorded = await rememberFreshness(deps, lane, { lastSeenReport, lastFreshnessNote: note });
      if (recorded && note !== current.lastFreshnessNote) {
        acts.push({ kind: hold.kind, lane: lane.key, detail: hold.detail });
      }
      return;
    }
    if (!hook || !allowAutomatic) return;
    const text = `Progress (from the lane's last report): ${scrubForThread(ownerLine ?? report ?? "", home)}`;
    const latest = await deps.registry.read(lane.key);
    if (!latest || !sameLaneGeneration(lane, latest) || !sameReceipt(current, latest)) return;
    const sent = await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
    // Only a delivered report counts as posted: a failed hook leaves it unposted, so the next tick sends it again. Like
    // a held-back report, the same failure is printed once, not on every retry.
    if (sent.code !== 0) {
      const detail = `thread hook failed (exit ${sent.code})`;
      const note = `post-failed|${detail}|${report}`;
      const recorded = await rememberFreshness(deps, lane, { lastSeenReport, lastFreshnessNote: note });
      if (recorded && note !== current.lastFreshnessNote) acts.push({ kind: "post-failed", lane: lane.key, detail });
      return;
    }
    await deps.registry.transition(lane, (live) =>
      sameReceipt(live, latest)
        ? {
            ...live,
            lastSeenReport,
            lastAutoReplyAt: now,
            lastPostedReport: report ?? undefined,
            lastPostedReportId: id,
            lastPostedReportOwner: owner,
            lastFreshnessNote: undefined,
          }
        : null,
    );
    acts.push({ kind: "posted", lane: lane.key, detail: text });
  }
};
