import { deployRelease } from "./deployment.ts";
import { reportPreAction } from "./pre-action-notice.ts";
import { publishRelease } from "./publish.ts";
import { PublicationHold } from "./publish-types.ts";
import { candidateReport, persistReport, reportCandidate } from "./report.ts";
import { assertSource } from "./source.ts";
import { persistJob, persistState, readJob } from "./state.ts";
import type { UpdateContext, UpdateJob, UpdateState } from "./types.ts";

export type PromotionOutcome = "candidate" | "held" | "promoted" | "deployed";

/** Ready is an immutable source verdict. Publication/deployment progress and failures live only in this subrecord. */
export async function promoteJob(ctx: UpdateContext, state: UpdateState, job: UpdateJob): Promise<PromotionOutcome> {
  const config = ctx.config.promotion;
  if (!config || job.phase !== "ready") return "candidate";
  if (job.promotion?.status === "complete") {
    if (state.active === job.id) {
      delete state.active;
      persistState(ctx, state);
    }
    const report = candidateReport(ctx, job);
    if (!report.ready) {
      job.problem = report.sourceProblem ?? "completed candidate source identity changed";
      persistJob(job);
      await reportCandidate(ctx, job);
      return "held";
    }
    await reportCandidate(ctx, job);
    return config.deployment ? "deployed" : "promoted";
  }
  job.promotion ??= { version: 1, status: "publishing" };
  const promotion = job.promotion;
  if (promotion.status === "held") {
    if (state.active === job.id) {
      delete state.active;
      persistState(ctx, state);
    }
    await reportCandidate(ctx, job);
    return "held";
  }
  state.active = job.id;
  persistState(ctx, state);
  persistJob(job);
  let outcome: PromotionOutcome = "held";
  let validated = false;
  try {
    if (job.configHash !== ctx.configHash) throw new Error("promotion job/config identity changed");
    const report = candidateReport(ctx, job);
    if (!report.ready) throw new Error(report.sourceProblem ?? "candidate is not ready for publication");
    validated = true;
    const published = await publishRelease(
      ctx,
      state,
      job,
      promotion.publication,
      (record) => {
        promotion.publication = record;
        persistJob(job);
      },
      ctx.config.reporter
        ? (publication) => reportPreAction(ctx, job, { action: "main-publication", publication })
        : undefined,
    );
    if (published.record.status === "held") {
      promotion.status = "held";
      promotion.problem = published.record.problem ?? "publication gate held";
    } else if (published.record.status !== "published") {
      outcome = "candidate"; // Exact-head CI is still running; the next ordinary cycle only reads promotion state.
    } else {
      if (config.deployment && published.observedMain !== published.record.commit) {
        promotion.status = "held";
        throw new Error("published main changed; deployment held; effective baseline retained");
      }
      if (config.deployment) {
        promotion.status = "deploying";
        persistJob(job);
        promotion.deployment = await deployRelease(
          config.deployment,
          {
            remote: config.publish.remote,
            commit: published.record.commit!,
            tree: published.record.tree!,
            sourceHash: job.sourceHash!,
            candidate: job.candidate,
            publicManifest: published.publicManifest,
          },
          promotion.deployment,
          (record) => {
            promotion.deployment = record;
            persistJob(job);
          },
          ctx.signal,
          ctx.config.reporter
            ? (deployment) => reportPreAction(ctx, job, { action: "dori-replacement", deployment })
            : undefined,
        );
        if (promotion.deployment.status !== "healthy") {
          promotion.status = promotion.deployment.retryableHold ? "deploying" : "held";
          promotion.problem = `deployment ${promotion.deployment.status}; effective baseline retained`;
        }
      }
      if (!config.deployment || promotion.deployment?.status === "healthy") {
        assertSource(job);
        // Persist baseline before complete so a crash resumes full readback instead of skipping this write.
        state.baseline = job.upstream;
        persistState(ctx, state);
        promotion.status = "complete";
        promotion.completedAt = new Date().toISOString();
        delete promotion.problem;
        outcome = config.deployment ? "deployed" : "promoted";
      }
    }
  } catch (error) {
    promotion.problem = error instanceof Error ? error.message : "promotion interrupted; intent retained";
    // Interrupted remote commands retain their exact intent for readback. Source/gate failures have no retry effects.
    if (!validated || error instanceof PublicationHold || promotion.publication?.status === "held")
      promotion.status = "held";
  } finally {
    persistJob(job);
    delete state.active;
    persistState(ctx, state);
  }
  if (outcome === "candidate") {
    persistReport(ctx, job);
    ctx.emit({
      type: "DORI_UPDATE",
      target: "dori",
      event: "promotion-pending",
      job: job.id,
      phase: job.phase,
      upstream: job.upstream,
    });
  } else await reportCandidate(ctx, job);
  return outcome;
}

/** Resume nonterminal ready work before detector/dedup. No model, provisioning, checks or reviewer are run here. */
export function pendingPromotion(ctx: UpdateContext, state: UpdateState): UpdateJob | undefined {
  if (!ctx.config.promotion) return undefined;
  for (const id of Object.values(state.jobs)) {
    const job = readJob(ctx.config.root, id);
    if (job.phase === "ready" && job.promotion?.status !== "complete" && job.promotion?.status !== "held") return job;
  }
  return undefined;
}
