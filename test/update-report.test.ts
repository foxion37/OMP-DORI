import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pendingPromotion } from "../src/update/promotion.ts";
import { publicSource } from "../src/update/publish-export.ts";
import type { PublicationRecord } from "../src/update/publish-types.ts";
import { reportCandidate } from "../src/update/report.ts";
import { persistJob, readJob, readState } from "../src/update/state.ts";
import { git, publicationFixture } from "./update-setup.ts";

test.each(["deployment", "publication"] as const)(
  "retryable %s progress preserves the one terminal rollback or CI-failure notification",
  async (stage) => {
    const f = await publicationFixture(() => ({
      reporter: {
        name: "notify",
        argv: [process.execPath, "-e", "process.stdout.write(process.argv[1]);", "{text}"],
        timeoutMs: 10_000,
      },
    }));
    const commands = structuredClone(f.job.commands);
    const history = structuredClone(f.job.history);
    const review = structuredClone(f.job.review);
    const configHash = f.updater.context.configHash;
    const tree = git(f.remote, "rev-parse", "HEAD^{tree}");
    const exportHash = publicSource(f.job).hash;
    const basis: PublicationRecord["basis"] =
      stage === "deployment"
        ? {
            kind: "initial-source",
            pins: {
              main: f.expectedMain,
              sourceHash: f.job.inputs!.local.hash,
              exportHash,
              baseUpstream: f.job.baseUpstream,
              upstream: f.job.upstream,
            },
          }
        : { kind: "matched-main" };
    const publicationLabel = stage === "deployment" ? "historical-replay initial-source" : null;
    // Exercise the reporting consumer with durable promotion receipts, without running a native deployment.
    f.job.promotion = {
      version: 1,
      status: stage === "deployment" ? "deploying" : "publishing",
      problem: stage === "deployment" ? "runtime busy; retry after quiescence" : "transient CI readback failure",
      publication: {
        version: 1,
        status: stage === "deployment" ? "published" : "awaiting-ci",
        basis,
        remote: f.target,
        ref: "refs/heads/main",
        branch: `refs/heads/dori-update/${f.job.id}`,
        expectedMain: f.expectedMain,
        sourceHash: f.job.sourceHash!,
        exportHash,
        commit: f.job.upstream,
        tree,
        createdAt: f.job.createdAt,
        updatedAt: f.job.updatedAt,
      },
      ...(stage === "deployment"
        ? {
            deployment: {
              version: 1 as const,
              id: f.job.id,
              inputHash: f.job.sourceHash!,
              configHash,
              commit: f.job.upstream,
              tree,
              sourceHash: f.job.sourceHash!,
              releasePath: f.job.candidate,
              directory: join(f.job.directory, "deployment"),
              createdAt: f.job.createdAt,
              status: "held" as const,
              step: "prepare" as const,
              retryableHold: true,
            },
          }
        : {}),
    };
    persistJob(f.job);
    await reportCandidate(f.updater.context, f.job);
    const resumed = readJob(f.config.root, f.job.id);
    await reportCandidate(f.updater.context, resumed);
    expect(resumed.notification).toBeUndefined();
    expect(resumed.promotion?.notifications).toBeUndefined();
    expect(resumed.commands).toEqual(commands);
    expect(f.events.some((event) => event.event === "promotion-held")).toBe(false);
    expect(pendingPromotion(f.updater.context, readState(f.updater.context))?.id).toBe(f.job.id);
    expect(JSON.parse(readFileSync(join(f.job.directory, "report.json"), "utf8"))).toMatchObject({
      ready: true,
      promotion: { status: stage === "deployment" ? "deploying" : "publishing" },
      publicationBasis: basis,
      publicationLabel,
    });

    const promotion = resumed.promotion!;
    promotion.status = "held";
    if (stage === "deployment") {
      promotion.deployment!.status = "rolled-back";
      promotion.deployment!.step = "done";
      promotion.deployment!.rollbackHealthyAt = new Date().toISOString();
      delete promotion.deployment!.retryableHold;
      promotion.problem = "deployment rolled back after failed health; effective baseline retained";
    } else {
      promotion.publication!.status = "held";
      promotion.publication!.problem = "required exact-head CI failed";
      promotion.problem = promotion.publication!.problem;
    }
    persistJob(resumed);
    await reportCandidate(f.updater.context, resumed);
    const delivered = readJob(f.config.root, f.job.id);
    expect(delivered.promotion?.notifications?.["promotion-held"]).toEqual({ state: "sent", exitCode: 0 });
    const notifications = delivered.commands.filter((receipt) => receipt.name === "notify");
    expect(notifications).toHaveLength(1);
    const text = readFileSync(notifications[0]!.stdout, "utf8");
    expect(text).not.toContain(f.directory);
    expect(JSON.parse(text)).toMatchObject({
      outcome: "promotion-held",
      promotionStatus: "held",
      publicationStatus: stage === "deployment" ? "published" : "held",
      deploymentStatus: stage === "deployment" ? "rolled-back" : null,
      publicationBasis: basis,
      publicationLabel,
    });
    await reportCandidate(f.updater.context, delivered);
    expect(delivered.commands.filter((receipt) => receipt.name === "notify")).toHaveLength(1);
    expect(delivered.commands.slice(0, commands.length)).toEqual(commands);
    expect(delivered.phase).toBe("ready");
    expect(delivered.sourceHash).toBe(f.job.sourceHash);
    expect(delivered.history).toEqual(history);
    expect(delivered.review).toEqual(review);
    expect(f.updater.context.configHash).toBe(configHash);
    expect(readState(f.updater.context).baseline).toBeUndefined();
  },
);
