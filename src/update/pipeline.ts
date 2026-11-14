import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateError } from "./config.ts";
import { prepareCandidate } from "./prepare.ts";
import { runCommand } from "./process.ts";
import { parseReview, portPrompt, readPortResult, reviewPrompt } from "./review.ts";
import {
  assertDoriScope,
  assertFrozen,
  assertSource,
  assertSourceAdmission,
  gitIdentity,
  sourceManifest,
} from "./source.ts";
import { saveJson, transition } from "./state.ts";
import type { UpdateContext, UpdateJob } from "./types.ts";

/** Source normalization may never move the frozen inputs, opaque local ULW pin or Git identity. */
function assertBoundary(job: UpdateJob, metadata: string): void {
  const source = sourceManifest(job.candidate);
  assertSourceAdmission(source, "candidate");
  assertDoriScope(job.inputs!, source);
  if (gitIdentity(job.candidate) !== metadata) {
    throw new UpdateError("candidate Git metadata changed: commits/staging/config edits are outside this port");
  }
}

function bind(job: UpdateJob, metadata: string): void {
  assertSource(job);
  assertBoundary(job, metadata);
}

/** Trusted explicit preparation precedes the one final source freeze; checks never normalize or repair it. */
export async function verifyCandidate(ctx: UpdateContext, job: UpdateJob, metadata: string): Promise<string> {
  if (job.phase !== "porting" || job.sourceHash !== undefined) {
    throw new UpdateError("verification requires an unfinalized porting candidate; no retry or source rebinding");
  }
  assertSourceAdmission(sourceManifest(job.candidate), "upstream");
  for (const command of ctx.config.provision) {
    assertFrozen(job);
    assertBoundary(job, metadata);
    try {
      await runCommand(ctx, job, command);
    } finally {
      assertFrozen(job);
      assertBoundary(job, metadata);
    }
  }
  const source = sourceManifest(job.candidate);
  assertSourceAdmission(source, "candidate");
  job.sourceHash = source.hash;
  bind(job, metadata);
  saveJson(join(job.directory, "ported-source.json"), source);
  transition(ctx, job, "verifying");
  for (const command of ctx.config.checks) {
    bind(job, metadata);
    await runCommand(ctx, job, command);
    bind(job, metadata);
  }
  return source.hash;
}

export async function buildCandidate(ctx: UpdateContext, job: UpdateJob): Promise<void> {
  await prepareCandidate(ctx, job);
  const metadata = gitIdentity(job.candidate);
  assertFrozen(job);
  assertBoundary(job, metadata);
  transition(ctx, job, "porting");
  const brief = join(job.directory, "port.txt");
  const prompt = portPrompt(job);
  writeFileSync(brief, prompt, { mode: 0o400, flag: "wx" });
  await runCommand(ctx, job, ctx.config.worker, { prompt, brief }, "model");
  assertFrozen(job);
  job.port = readPortResult(job);
  const sourceHash = await verifyCandidate(ctx, job, metadata);
  transition(ctx, job, "reviewing");
  const reviewBrief = join(job.directory, "review.txt");
  const reviewText = reviewPrompt(job);
  writeFileSync(reviewBrief, reviewText, { mode: 0o400, flag: "wx" });
  bind(job, metadata);
  const result = await runCommand(ctx, job, ctx.config.reviewer, { prompt: reviewText, brief: reviewBrief }, "model");
  bind(job, metadata);
  job.review = parseReview(result.stdout, sourceHash);
  saveJson(join(job.directory, "review.json"), job.review);
  transition(ctx, job, job.review.verdict === "approve" ? "ready" : "rejected");
}
