import { DeploymentHeld } from "./deployment-process.ts";
import type { DeploymentRecord } from "./deployment-types.ts";
import { runCommand } from "./process.ts";
import { PublicationHold, type PublicationRecord } from "./publish-types.ts";
import { digest } from "./source.ts";
import { persistJob } from "./state.ts";
import type { PreActionNotice, UpdateContext, UpdateJob } from "./types.ts";

type Notice =
  | { readonly action: "main-publication"; readonly publication: PublicationRecord }
  | { readonly action: "dori-replacement"; readonly deployment: DeploymentRecord };

function acceptedReceipt(ctx: UpdateContext, job: UpdateJob, index: number): boolean {
  const receipt = Number.isInteger(index) && index >= 0 ? job.commands[index] : undefined;
  return (
    receipt !== undefined &&
    receipt.name === ctx.config.reporter?.name &&
    receipt.sourceHash === job.sourceHash &&
    Number.isInteger(receipt.pid) &&
    receipt.pid! > 0 &&
    receipt.finishedAt !== undefined &&
    Number.isFinite(Date.parse(receipt.finishedAt)) &&
    receipt.error === undefined &&
    receipt.signal === undefined &&
    receipt.exitCode === 0
  );
}

/** Only these two forward effects use a delivery barrier; terminal reporting keeps its separate receipt. */
export async function reportPreAction(ctx: UpdateContext, job: UpdateJob, notice: Notice): Promise<void> {
  if (!ctx.config.reporter) return;
  const Hold = notice.action === "main-publication" ? PublicationHold : DeploymentHeld;
  const intent =
    notice.action === "main-publication"
      ? {
          commit: notice.publication.commit,
          tree: notice.publication.tree,
          remote: notice.publication.remote,
          ref: notice.publication.ref,
          branch: notice.publication.branch,
          expectedMain: notice.publication.expectedMain,
          sourceHash: notice.publication.sourceHash,
          exportHash: notice.publication.exportHash,
          pullRequest: notice.publication.pullRequest ?? null,
        }
      : {
          deployment: notice.deployment.id,
          inputHash: notice.deployment.inputHash,
          configHash: notice.deployment.configHash,
          commit: notice.deployment.commit,
          tree: notice.deployment.tree,
          sourceHash: notice.deployment.sourceHash,
        };
  const intentHash = digest(JSON.stringify({ job: job.id, action: notice.action, config: ctx.configHash, intent }));
  const retained = job.preActionNotices?.[notice.action];
  if (retained !== undefined) {
    if (
      retained.job === job.id &&
      retained.action === notice.action &&
      retained.intentHash === intentHash &&
      retained.state === "accepted" &&
      retained.exitCode === 0 &&
      acceptedReceipt(ctx, job, retained.commandIndex)
    )
      return;
    if (retained.state === "sending") {
      retained.state = "ambiguous";
      persistJob(job);
    }
    throw new Hold(`pre-action ${notice.action} notice lacks a matching accepted receipt; action held`);
  }
  const text = JSON.stringify({
    type: "DORI_UPDATE",
    target: "dori",
    outcome: `before-${notice.action}`,
    job: job.id,
    publicationCommit: intent.commit,
    ...(notice.action === "main-publication"
      ? { ref: notice.publication.ref, pullRequest: notice.publication.pullRequest ?? null }
      : { deploymentIntent: notice.deployment.id }),
  });
  const delivery: PreActionNotice = {
    job: job.id,
    action: notice.action,
    intentHash,
    commandIndex: job.commands.length,
    state: "sending",
  };
  job.preActionNotices ??= {};
  job.preActionNotices[notice.action] = delivery;
  persistJob(job);
  try {
    await runCommand(
      ctx,
      job,
      ctx.config.reporter,
      { text, job: job.id, upstream: job.upstream, phase: job.phase },
      "reporter",
    );
    if (!acceptedReceipt(ctx, job, delivery.commandIndex)) throw new Hold("reporter has no complete zero-exit receipt");
  } catch {
    const receipt = job.commands[delivery.commandIndex];
    delivery.state =
      receipt?.pid === undefined
        ? "failed"
        : receipt.error !== undefined || receipt.signal !== undefined || !Number.isInteger(receipt.exitCode)
          ? "ambiguous"
          : receipt.exitCode === 0
            ? "ambiguous"
            : "failed";
    if (receipt?.exitCode !== undefined) delivery.exitCode = receipt.exitCode;
    persistJob(job);
    throw new Hold(`pre-action ${notice.action} notice delivery ${delivery.state}; action held`);
  }
  delivery.state = "accepted";
  delivery.exitCode = 0;
  persistJob(job);
}
