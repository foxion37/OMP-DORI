import { join } from "node:path";
import { object, UpdateError } from "./config.ts";
import { assertPublicationBasis, publicationBasis } from "./publish-basis.ts";
import { publicCommit, publicSource } from "./publish-export.ts";
import { githubGate } from "./publish-github.ts";
import { PublicationProcess } from "./publish-process.ts";
import { PublicationHold, type PublicationRecord } from "./publish-types.ts";
import { assertSource } from "./source.ts";
import type { SourceManifest, UpdateContext, UpdateJob, UpdateState } from "./types.ts";

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const CI_DEADLINE_PROBLEM = "exact-head GitHub CI/merge readiness deadline expired; publication held";

async function remoteRefs(process: PublicationProcess, branch: string) {
  const ref = process.config.ref;
  const raw = await process.git(["ls-remote", "--refs", "--", process.config.remote, ref, branch], undefined, true);
  const refs = new Map<string, string>();
  for (const row of raw.trim() ? raw.trim().split(/\r?\n/) : []) {
    const [sha, name] = row.split(/\s+/);
    if (!sha || !SHA.test(sha) || !name || ![ref, branch].includes(name) || refs.has(name)) {
      throw new UpdateError("publication remote ref readback is ambiguous");
    }
    refs.set(name, sha);
  }
  const main = refs.get(ref);
  if (!main) throw new PublicationHold("publication target branch must already exist with its own history");
  return { main, branch: refs.get(branch) };
}

async function fetchCommit(process: PublicationProcess, commit: string): Promise<void> {
  await process.git(["init", "--bare", "--quiet", ...(commit.length === 64 ? ["--object-format=sha256"] : [])]);
  await process.git(
    [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--",
      process.config.remote,
      commit,
    ],
    undefined,
    true,
  );
}

async function publishedAncestor(process: PublicationProcess, commit: string, main: string): Promise<boolean> {
  await fetchCommit(process, main);
  return (await process.git(["merge-base", commit, main])).trim() === commit;
}
export async function publishRelease(
  ctx: UpdateContext,
  state: UpdateState,
  job: UpdateJob,
  previous: PublicationRecord | undefined,
  persist: (record: PublicationRecord) => void,
  beforeMainPush?: (record: PublicationRecord) => Promise<void>,
): Promise<{
  readonly record: PublicationRecord;
  readonly publicManifest: SourceManifest;
  readonly observedMain?: string;
}> {
  const config = ctx.config.promotion!.publish;
  let manifest: SourceManifest;
  try {
    manifest = publicSource(job);
  } catch (error) {
    if (error instanceof UpdateError || error instanceof SyntaxError) throw new PublicationHold(error.message);
    throw error;
  }
  const process = new PublicationProcess(config, join(job.directory, "publication"), ctx.signal);
  const branch = `refs/heads/dori-update/${job.id}`;
  let record = previous;
  if (
    record &&
    (record.version !== 1 ||
      record.remote !== config.remote ||
      record.ref !== config.ref ||
      record.branch !== branch ||
      record.sourceHash !== job.sourceHash ||
      record.exportHash !== manifest.hash ||
      typeof record.createdAt !== "string" ||
      typeof record.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      !SHA.test(record.expectedMain) ||
      !["prepared", "branch-pushing", "awaiting-ci", "main-pushing", "published", "held"].includes(record.status) ||
      (record.status !== "prepared" && record.status !== "held" && (!record.commit || !record.tree)) ||
      (record.commit !== undefined && !SHA.test(record.commit)) ||
      (record.tree !== undefined && !SHA.test(record.tree)) ||
      (record.ciWait !== undefined &&
        (!object(record.ciWait) ||
          typeof record.ciWait.startedAt !== "string" ||
          typeof record.ciWait.deadlineAt !== "string" ||
          !Number.isFinite(Date.parse(record.ciWait.startedAt)) ||
          !Number.isFinite(Date.parse(record.ciWait.deadlineAt)) ||
          Date.parse(record.ciWait.deadlineAt) <= Date.parse(record.ciWait.startedAt))))
  )
    throw new PublicationHold("persisted publication intent does not match this checked job/configuration");
  if (record) assertPublicationBasis(ctx, state, job, manifest, record);
  if (record?.status === "held") return { record, publicManifest: manifest };
  if (!record) {
    const observed = await remoteRefs(process, branch);
    if (observed.branch) throw new PublicationHold("publication branch already exists without owned durable intent");
    await fetchCommit(process, observed.main);
    const basis = await publicationBasis(ctx, state, process, job, manifest, observed.main);
    const at = new Date().toISOString();
    record = {
      version: 1,
      status: "prepared",
      remote: config.remote,
      ref: config.ref,
      branch,
      expectedMain: observed.main,
      basis,
      sourceHash: job.sourceHash!,
      exportHash: manifest.hash,
      createdAt: at,
      updatedAt: at,
    };
    persist(record);
  }
  const current = record;
  const save = (): void => {
    current.updatedAt = new Date().toISOString();
    persist(current);
  };
  const held = (problem: string) => {
    current.status = "held";
    current.problem = problem;
    save();
    return { record: current, publicManifest: manifest };
  };
  const waitingExpired = (startedAt = current.createdAt): boolean => {
    if (!config.github) return false;
    if (!current.ciWait) {
      // Legacy receipts lack a first-wait timestamp; immutable creation time supplies a conservative bound.
      const timeoutMs = Math.max(
        3_600_000,
        Math.min(
          86_400_000,
          ctx.config.checks.reduce((sum, check) => sum + check.timeoutMs, 0),
        ),
      );
      current.ciWait = { startedAt, deadlineAt: new Date(Date.parse(startedAt) + timeoutMs).toISOString() };
      save();
    }
    return Date.now() >= Date.parse(current.ciWait.deadlineAt);
  };
  try {
    if (current.status === "awaiting-ci" && waitingExpired()) return held(CI_DEADLINE_PROBLEM);
    if (previous) await fetchCommit(process, current.expectedMain);
    const built = await publicCommit(process, job, manifest, current.expectedMain, current.basis);
    if ((current.commit && current.commit !== built.commit) || (current.tree && current.tree !== built.tree)) {
      return held("retained public commit/tree changed identity");
    }
    current.commit = built.commit;
    current.tree = built.tree;
    save();
    let observed = await remoteRefs(process, branch);
    if (["main-pushing", "published"].includes(current.status)) {
      if (config.github && current.ci?.head !== current.commit) {
        return held("main changed before the configured publication intent/gates");
      }
      if (await publishedAncestor(process, current.commit, observed.main)) {
        current.status = "published";
        delete current.problem;
        save();
        return { record: current, publicManifest: manifest, observedMain: observed.main };
      }
    }
    if (observed.main === current.commit) return held("main changed before the configured publication intent/gates");
    if (observed.main !== current.expectedMain || current.status === "published") {
      return held("publication main moved; owner history was retained and no force push was attempted");
    }
    if (observed.branch !== undefined && observed.branch !== current.commit) {
      return held("owned publication branch moved; no ref was overwritten");
    }
    if (observed.branch === undefined) {
      if (!["prepared", "branch-pushing"].includes(current.status)) {
        return held("owned publication branch disappeared after confirmed push");
      }
      current.status = "branch-pushing";
      save();
      assertSource(job);
      let failed = false;
      try {
        await process.git(["push", "--porcelain", "--", config.remote, `${current.commit}:${branch}`], undefined, true);
      } catch {
        failed = true;
      }
      observed = await remoteRefs(process, branch);
      if (observed.main !== current.expectedMain) return held("publication main moved during candidate push");
      if (observed.branch !== current.commit) {
        if (observed.branch !== undefined) return held("publication branch changed during candidate push");
        throw new UpdateError(
          failed
            ? "candidate push failed; intent retained for readback"
            : "candidate push has no exact remote readback",
        );
      }
    }
    current.status = "awaiting-ci";
    delete current.problem;
    save();
    if (waitingExpired(current.updatedAt)) return held(CI_DEADLINE_PROBLEM);
    const gate = await githubGate(process, current, save);
    if (gate.state === "held") return held(gate.problem!);
    if (waitingExpired()) return held(CI_DEADLINE_PROBLEM);
    if (gate.state === "waiting") return { record: current, publicManifest: manifest };
    await beforeMainPush?.(current);
    if (waitingExpired()) return held(CI_DEADLINE_PROBLEM);
    observed = await remoteRefs(process, branch);
    if (observed.main !== current.expectedMain || observed.branch !== current.commit) {
      return held("publication refs moved after exact-head checks; main was retained");
    }
    current.status = "main-pushing";
    save();
    assertSource(job);
    let failed = false;
    try {
      await process.git(
        ["push", "--porcelain", "--", config.remote, `${current.commit}:${config.ref}`],
        undefined,
        true,
      );
    } catch {
      failed = true;
    }
    observed = await remoteRefs(process, branch);
    if (!(await publishedAncestor(process, current.commit, observed.main))) {
      if (observed.main !== current.expectedMain)
        return held("publication main moved during push; no force push was attempted");
      throw new UpdateError(
        failed ? "main push failed; intent retained for readback" : "main push has no exact remote readback",
      );
    }
    current.status = "published";
    delete current.problem;
    save();
    return { record: current, publicManifest: manifest, observedMain: observed.main };
  } catch (error) {
    if (error instanceof PublicationHold) return held(error.message);
    if (current.status === "awaiting-ci" && waitingExpired()) return held(CI_DEADLINE_PROBLEM);
    current.problem = error instanceof Error ? error.message : "publication interrupted";
    save();
    throw error;
  }
}
