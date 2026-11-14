import { join } from "node:path";
import { UpdateError } from "./config.ts";
import { runCommand } from "./process.ts";
import type { PublicationRecord } from "./publish-types.ts";
import { assertSource } from "./source.ts";
import { persistJob, saveJson } from "./state.ts";
import type { CommandReceipt, UpdateCommand, UpdateContext, UpdateJob } from "./types.ts";

/** The complete private report. Receipts count for a check only when bound to the exact checked source hash. */
export function candidateReport(ctx: UpdateContext, job: UpdateJob) {
  const latest = (name: string): CommandReceipt | undefined =>
    job.sourceHash === undefined
      ? undefined
      : job.commands.findLast((receipt) => receipt.name === name && receipt.sourceHash === job.sourceHash);
  const ran = (command: UpdateCommand, receipt: CommandReceipt | undefined) => ({
    name: command.name,
    exitCode: receipt?.exitCode ?? null,
    receipt: receipt ?? null,
  });
  // Preparation intentionally precedes the final source hash; only immutable checks attest that hash.
  const provision = ctx.config.provision.map((command) =>
    ran(
      command,
      job.commands.findLast((receipt) => receipt.name === command.name),
    ),
  );
  const checks = ctx.config.checks.map((command) => ran(command, latest(command.name)));
  if (
    job.phase === "ready" &&
    (!job.sourceHash ||
      checks.length === 0 ||
      [...provision, ...checks].some((item) => item.exitCode !== 0) ||
      job.review === undefined ||
      job.review.sourceHash !== job.sourceHash ||
      job.review.verdict !== "approve")
  ) {
    throw new UpdateError("ready candidate lacks passed checks and a fresh review bound to its source");
  }
  let sourceProblem: string | null = null;
  if (job.phase === "ready") {
    try {
      assertSource(job);
    } catch (error) {
      if (!ctx.config.promotion) throw error;
      sourceProblem = error instanceof Error ? error.message : "candidate source identity changed";
    }
  }
  const published = job.promotion?.publication?.status === "published";
  const deployed = job.promotion?.deployment?.status === "healthy" && job.promotion.status === "complete";
  const basis = job.promotion?.publication?.basis;
  const publicationBasis: PublicationRecord["basis"] | null =
    basis?.kind === "initial-source"
      ? {
          kind: basis.kind,
          pins: {
            main: basis.pins.main,
            sourceHash: basis.pins.sourceHash,
            exportHash: basis.pins.exportHash,
            baseUpstream: basis.pins.baseUpstream,
            upstream: basis.pins.upstream,
          },
        }
      : basis?.kind === "matched-main"
        ? { kind: basis.kind }
        : null;
  return {
    version: 1,
    target: "dori",
    candidateOnly: !published,
    ready: job.phase === "ready" && sourceProblem === null,
    sourceCurrent: job.phase === "ready" ? sourceProblem === null : null,
    sourceProblem,
    published,
    deployed,
    publicationBasis,
    publicationLabel: publicationBasis?.kind === "initial-source" ? "historical-replay initial-source" : null,
    promotion: job.promotion ?? null,
    publicationRequested: ctx.config.promotion !== undefined,
    deploymentRequested: ctx.config.promotion?.deployment !== undefined,
    activationRequiresNewOwnerApproval: ctx.config.promotion === undefined,
    job: job.id,
    phase: job.phase,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    upstream: job.upstream,
    baseUpstream: job.baseUpstream,
    localSourceHash: job.inputs?.local.hash ?? null,
    upstreamSourceHash: job.inputs?.incoming.hash ?? null,
    baseSourceHash: job.inputs?.base.hash ?? null,
    candidateSourceHash: job.sourceHash ?? null,
    candidate: job.candidate,
    inputs: join(job.directory, "inputs", "manifest.json"),
    provision,
    checks,
    commands: job.commands,
    reviewer: job.review ?? null,
    port: job.port ?? null,
    problem: job.problem ?? null,
    notification: job.notification ?? null,
    preActionNotices: job.preActionNotices ?? null,
    rollback: {
      frozenLocalSource: join(job.directory, "inputs", "local"),
      frozenBaseUpstream: join(job.directory, "inputs", "base"),
      preparedSource: join(job.directory, "inputs", "upstream"),
    },
    limitations: [
      "Environment and path isolation is not an OS sandbox.",
      ...(deployed ? [] : ["No healthy live activation has been observed for this candidate."]),
      "Readiness covers only the configured verification commands and the fresh review's stated limits.",
    ],
  };
}

/** Full paths/evidence stay in a private local artifact. Monitor/reporter output is a fixed, path-free projection. */
export function persistReport(ctx: UpdateContext, job: UpdateJob): void {
  saveJson(join(job.directory, "report.json"), candidateReport(ctx, job));
}

/** Classify a finished-or-killed reporter. A started process that did not exit cleanly may have delivered. */
function deliveryOf(receipt: CommandReceipt | undefined): NonNullable<UpdateJob["notification"]> {
  if (receipt === undefined || receipt.pid === undefined) return { state: "failed" };
  if (receipt.error !== undefined || receipt.signal !== undefined || receipt.exitCode === undefined)
    return { state: "ambiguous" };
  return { state: "failed", exitCode: receipt.exitCode };
}

/**
 * Records the candidate outcome and, when configured, sends one fixed path-free projection through the trusted
 * reporter. Intent is durable before the external write; a failed or ambiguous send is retained, never resent.
 */
export async function reportCandidate(ctx: UpdateContext, job: UpdateJob): Promise<void> {
  const report = candidateReport(ctx, job);
  persistReport(ctx, job);
  // Retryable promotion progress retains private evidence without consuming a terminal notification.
  if (job.promotion && job.promotion.status !== "held" && job.promotion.status !== "complete") return;
  const outcome = report.deployed
    ? "deployed"
    : job.promotion?.status === "complete"
      ? "promoted"
      : job.promotion
        ? "promotion-held"
        : "candidate";
  if (job.promotion ? job.promotion.notifications?.[outcome] !== undefined : job.notification !== undefined) return;
  ctx.emit({
    type: "DORI_UPDATE",
    target: "dori",
    event: outcome,
    job: job.id,
    phase: job.phase,
    upstream: job.upstream,
  });
  if (!ctx.config.reporter || ctx.signal?.aborted) return;
  if (job.promotion) job.promotion.notifications ??= {};
  job.notification = { state: "sending" };
  if (job.promotion) job.promotion.notifications![outcome] = job.notification;
  persistJob(job);
  persistReport(ctx, job);
  const text = JSON.stringify({
    type: "DORI_UPDATE",
    target: "dori",
    candidateOnly: report.candidateOnly,
    outcome,
    published: report.published,
    deployed: report.deployed,
    publicationCommit: job.promotion?.publication?.commit ?? null,
    publicationBasis: report.publicationBasis,
    publicationLabel: report.publicationLabel,
    promotionStatus: job.promotion?.status ?? null,
    publicationStatus: job.promotion?.publication?.status ?? null,
    publicationDeadline: job.promotion?.publication?.ciWait?.deadlineAt ?? null,
    deploymentStatus: job.promotion?.deployment?.status ?? null,
    job: job.id,
    phase: job.phase,
    upstream: job.upstream,
    baseUpstream: job.baseUpstream,
    localSourceHash: report.localSourceHash,
    candidateSourceHash: job.sourceHash ?? null,
    checkExits: report.checks.map((item) => item.exitCode),
    reviewer: job.review?.verdict ?? "unavailable",
    limitationCount: job.review?.limitations.length ?? 0,
    activationRequiresNewOwnerApproval: report.activationRequiresNewOwnerApproval,
  });
  const before = job.commands.length;
  try {
    const { receipt } = await runCommand(
      ctx,
      job,
      ctx.config.reporter,
      { text, job: job.id, upstream: job.upstream, phase: job.phase },
      "reporter",
    );
    job.notification = { state: "sent", exitCode: receipt.exitCode ?? 0 };
  } catch {
    job.notification = deliveryOf(job.commands.length > before ? job.commands.at(-1) : undefined);
    ctx.emit({
      type: "DORI_UPDATE",
      target: "dori",
      event: "report-delivery-held",
      job: job.id,
      phase: job.phase,
      upstream: job.upstream,
    });
  }
  if (job.promotion) job.promotion.notifications![outcome] = job.notification;
  persistJob(job);
  persistReport(ctx, job);
}
