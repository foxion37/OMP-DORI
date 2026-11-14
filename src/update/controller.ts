import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonical, UpdateInterrupted } from "./config.ts";
import { buildCandidate } from "./pipeline.ts";
import { detectHead } from "./prepare.ts";
import { pendingPromotion, promoteJob, type PromotionOutcome } from "./promotion.ts";
import { candidateReport, persistReport, reportCandidate } from "./report.ts";
import { assertSource, digest } from "./source.ts";
import { lockUpdate, persistJob, persistState, readJob, readLock, readState, saveJson, transition } from "./state.ts";
import type { UpdateConfig, UpdateContext, UpdateEvent, UpdateJob } from "./types.ts";

export type UpdateCycleResult = {
  readonly outcome: "unchanged" | "duplicate" | PromotionOutcome;
  readonly job?: UpdateJob;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One Dori ref and one hash-bound candidate at a time; optional standing promotion follows source readiness. */
export class DoriUpdater {
  readonly context: UpdateContext;

  constructor(
    config: UpdateConfig,
    emit: (event: UpdateEvent) => void = (event) => console.log(JSON.stringify(event)),
    signal?: AbortSignal,
  ) {
    this.context = {
      config,
      configHash: digest(JSON.stringify(config)),
      emit,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  /** Private local state and full reports. A stale or malformed candidate is reported as such, never promoted. */
  status() {
    const ctx = this.context;
    const state = readState(ctx);
    let lock: unknown = null;
    try {
      lock = readLock(ctx.config.root) ?? null;
    } catch (error) {
      lock = { malformed: messageOf(error) };
    }
    const jobs = Object.values(state.jobs).map((id) => {
      const job = readJob(ctx.config.root, id);
      try {
        return candidateReport(ctx, job);
      } catch (error) {
        return {
          version: 1,
          target: "dori",
          candidateOnly: job.promotion?.publication?.status !== "published",
          published: job.promotion?.publication?.status === "published",
          deployed: job.promotion?.deployment?.status === "healthy" && job.promotion.status === "complete",
          promotion: job.promotion ?? null,
          job: id,
          phase: job.phase,
          upstream: job.upstream,
          ready: false,
          problem: messageOf(error),
        };
      }
    });
    return {
      version: 1,
      target: "dori",
      candidateOnly: jobs.every((job) => job.candidateOnly),
      stagingOnly: ctx.config.promotion === undefined,
      state,
      lock,
      jobs,
    };
  }

  /** `check` skips the configured baseline; `stage` explicitly exercises the current pinned head (deduplicated). */
  async once(trigger: "check" | "stage" = "check"): Promise<UpdateCycleResult> {
    const release = lockUpdate(this.context);
    try {
      return await this.cycle(trigger);
    } finally {
      release();
    }
  }

  async watch(): Promise<"stopped" | "held"> {
    const ctx = this.context;
    const release = lockUpdate(ctx);
    try {
      while (!ctx.signal?.aborted) {
        try {
          if ((await this.cycle("check")).outcome === "held") return "held";
        } catch (error) {
          ctx.emit({ type: "DORI_UPDATE", target: "dori", event: "error" });
          saveJson(join(ctx.config.root, "watch-error.json"), {
            at: new Date().toISOString(),
            error: messageOf(error),
          });
          // Ambiguous work stays held for the operator; only a plain detector/network failure is retried next interval.
          if (error instanceof UpdateInterrupted || readState(ctx).active !== undefined) return "held";
        }
        await this.pause();
      }
      return "stopped";
    } finally {
      release();
    }
  }

  private async pause(): Promise<void> {
    const { signal, config } = this.context;
    if (signal?.aborted) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, config.intervalSeconds * 1000);
    signal?.addEventListener("abort", done, { once: true });
    await promise;
  }

  private async cycle(trigger: "check" | "stage"): Promise<UpdateCycleResult> {
    const ctx = this.context;
    const state = readState(ctx);
    if (state.active) {
      const job = readJob(ctx.config.root, state.active);
      if (job.phase === "ready" && ctx.config.promotion) return { outcome: await promoteJob(ctx, state, job), job };
      ctx.emit({
        type: "DORI_UPDATE",
        target: "dori",
        event: "held",
        job: job.id,
        phase: job.phase,
        upstream: job.upstream,
      });
      return { outcome: "held", job };
    }
    const pending = pendingPromotion(ctx, state);
    if (pending) return { outcome: await promoteJob(ctx, state, pending), job: pending };
    const sha = await detectHead(ctx);
    state.observed = sha;
    persistState(ctx, state);
    const seen = state.jobs[sha];
    if (seen) {
      const earlier = readJob(ctx.config.root, seen);
      if (earlier.phase === "ready") {
        try {
          assertSource(earlier);
        } catch (error) {
          // Changed code cannot inherit a stale passed verdict.
          earlier.problem = messageOf(error);
          if (ctx.config.promotion) persistJob(earlier);
          else transition(ctx, earlier, "failed");
          persistReport(ctx, earlier);
        }
      }
      ctx.emit({
        type: "DORI_UPDATE",
        target: "dori",
        event: "duplicate",
        job: earlier.id,
        phase: earlier.phase,
        upstream: sha,
      });
      return { outcome: "duplicate", job: earlier };
    }
    const baseline = state.baseline ?? ctx.config.baseUpstream;
    if (trigger === "check" && sha === baseline) {
      state.processed = sha;
      persistState(ctx, state);
      ctx.emit({ type: "DORI_UPDATE", target: "dori", event: "unchanged", upstream: sha });
      return { outcome: "unchanged" };
    }
    const id = digest(`${ctx.configHash}\n${sha}`);
    const directory = join(ctx.config.root, "jobs", id);
    if (existsSync(directory)) {
      throw new UpdateInterrupted(
        "a job directory exists without a state record; inspect it and move it aside manually",
      );
    }
    mkdirSync(join(ctx.config.root, "jobs"), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
    const at = new Date().toISOString();
    const job: UpdateJob = {
      version: 1,
      id,
      upstream: sha,
      baseUpstream: baseline,
      configHash: ctx.configHash,
      createdAt: at,
      updatedAt: at,
      phase: "prepared",
      candidate: join(directory, "candidate"),
      directory,
      commands: [],
      history: [{ phase: "prepared", at }],
    };
    saveJson(join(directory, "request.json"), {
      trigger: trigger === "stage" ? "manual-current-head" : "detected-ref-change",
      upstream: sha,
      baseUpstream: baseline,
    });
    persistJob(job);
    state.jobs[sha] = id;
    state.active = id;
    persistState(ctx, state);
    ctx.emit({ type: "DORI_UPDATE", target: "dori", event: "phase", job: id, phase: "prepared", upstream: sha });
    try {
      await buildCandidate({ ...ctx, config: { ...ctx.config, localSource: canonical(ctx.config.localSource) } }, job);
    } catch (error) {
      job.problem = messageOf(error);
      const last = job.commands.at(-1);
      const unproven =
        error instanceof UpdateInterrupted ||
        ctx.signal?.aborted === true ||
        last?.signal !== undefined ||
        last?.error !== undefined ||
        (last !== undefined && last.finishedAt === undefined);
      transition(ctx, job, unproven ? "interrupted" : "failed");
    }
    if (job.phase === "ready" && ctx.config.promotion) {
      state.processed = sha;
      return { outcome: await promoteJob(ctx, state, job), job };
    }
    await reportCandidate(ctx, job);
    if (job.phase !== "interrupted") {
      // Only an unproven/ambiguous run keeps ownership; every complete verdict (even a failed one) is deduplicated.
      state.processed = sha;
      delete state.active;
      persistState(ctx, state);
    }
    return { outcome: job.phase === "interrupted" ? "held" : "candidate", job };
  }
}
