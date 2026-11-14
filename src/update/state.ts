import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { alive } from "../../skills/dori-mode/scripts/src/checkpoint-lock.ts";
import { object, UpdateError } from "./config.ts";
import { claimPromotionRecovery } from "./publish-lock.ts";
import type { UpdateContext, UpdateJob, UpdateLock, UpdatePhase, UpdateState } from "./types.ts";

export function saveJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function readState(ctx: UpdateContext): UpdateState {
  const path = join(ctx.config.root, "state.json");
  if (!existsSync(path)) return { version: 1, configHash: ctx.configHash, jobs: {} };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(raw) || raw["version"] !== 1 || raw["configHash"] !== ctx.configHash || !object(raw["jobs"]))
    throw new UpdateError(
      "update state/config identity mismatch; retain it and use a separate root for changed configuration",
    );
  for (const [sha, id] of Object.entries(raw["jobs"])) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha) || typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw new UpdateError("update state has malformed job identities");
  }
  if (
    raw["baseline"] !== undefined &&
    (typeof raw["baseline"] !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(raw["baseline"]))
  ) {
    throw new UpdateError("update state has a malformed effective baseline");
  }
  if (
    raw["active"] !== undefined &&
    (typeof raw["active"] !== "string" || !Object.values(raw["jobs"]).includes(raw["active"]))
  )
    throw new UpdateError("update state has an unrecognized active job");
  if (
    raw["initialSourceJob"] !== undefined &&
    (typeof raw["initialSourceJob"] !== "string" || !Object.values(raw["jobs"]).includes(raw["initialSourceJob"]))
  )
    throw new UpdateError("update state has an unrecognized initial-source job claim");
  return raw as unknown as UpdateState;
}
export function readJob(root: string, id: string): UpdateJob {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new UpdateError("job must be its complete 64-character identity");
  const directory = join(root, "jobs", id);
  const raw: unknown = JSON.parse(readFileSync(join(directory, "job.json"), "utf8"));
  if (
    !object(raw) ||
    raw["version"] !== 1 ||
    raw["id"] !== id ||
    raw["directory"] !== directory ||
    raw["candidate"] !== join(directory, "candidate") ||
    !Array.isArray(raw["commands"]) ||
    !Array.isArray(raw["history"])
  )
    throw new UpdateError("candidate job record is malformed or belongs to another root");
  if (
    !["prepared", "porting", "verifying", "reviewing", "ready", "failed", "rejected", "interrupted"].includes(
      String(raw["phase"]),
    )
  )
    throw new UpdateError("candidate job has an unknown phase");
  const promotion = raw["promotion"];
  if (
    promotion !== undefined &&
    (!object(promotion) ||
      promotion["version"] !== 1 ||
      !["publishing", "deploying", "complete", "held"].includes(String(promotion["status"])))
  )
    throw new UpdateError("candidate promotion record is malformed");
  return raw as unknown as UpdateJob;
}
export const persistJob = (job: UpdateJob): void => saveJson(join(job.directory, "job.json"), job);
export const persistState = (ctx: UpdateContext, state: UpdateState): void => {
  const claimed = readState(ctx).initialSourceJob;
  if (claimed !== undefined && state.initialSourceJob !== claimed) {
    throw new UpdateError("initial-source job claim is immutable");
  }
  saveJson(join(ctx.config.root, "state.json"), state);
};

export function transition(ctx: UpdateContext, job: UpdateJob, phase: UpdatePhase): void {
  const next: Partial<Record<UpdatePhase, readonly UpdatePhase[]>> = {
    prepared: ["porting"],
    porting: ["verifying"],
    verifying: ["reviewing"],
    reviewing: ["ready", "rejected"],
  };
  if (!["failed", "interrupted"].includes(phase) && !next[job.phase]?.includes(phase))
    throw new UpdateError(`invalid updater transition ${job.phase} -> ${phase}`);
  job.phase = phase;
  job.updatedAt = new Date().toISOString();
  job.history.push({ phase, at: job.updatedAt });
  persistJob(job);
  ctx.emit({ type: "DORI_UPDATE", target: "dori", event: "phase", job: job.id, phase, upstream: job.upstream });
}

export function readLock(root: string): UpdateLock | undefined {
  const path = join(root, "controller.lock");
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined; // a writer stopped between creating the lock and writing it
  }
  if (
    !object(raw) ||
    raw["version"] !== 1 ||
    !Number.isSafeInteger(raw["pid"]) ||
    Number(raw["pid"]) <= 0 ||
    typeof raw["nonce"] !== "string" ||
    typeof raw["host"] !== "string"
  )
    throw new UpdateError("malformed controller lock; retain evidence and inspect it manually");
  return raw as unknown as UpdateLock;
}

function recoverPromotionLock(ctx: UpdateContext, owner: UpdateLock | undefined, claim: UpdateLock): boolean {
  if (!ctx.config.promotion || !owner || owner.host !== hostname() || alive(owner.pid)) return false;
  const state = readState(ctx);
  const candidates = state.active ? [state.active] : Object.values(state.jobs);
  const job = candidates
    .map((id) => readJob(ctx.config.root, id))
    .find(
      (candidate) =>
        candidate.phase === "ready" && (state.active === candidate.id || candidate.promotion?.status !== "complete"),
    );
  if (!job || job.review?.verdict !== "approve" || job.review.sourceHash !== job.sourceHash) return false;
  if (
    job.commands.some(
      (command) =>
        command.name !== ctx.config.reporter?.name &&
        (command.finishedAt === undefined ||
          command.exitCode !== 0 ||
          command.signal !== undefined ||
          command.error !== undefined),
    )
  )
    return false;
  if (!claimPromotionRecovery(ctx.config.root, owner, claim)) return false;
  if (readLock(ctx.config.root)?.nonce !== owner.nonce || alive(owner.pid)) return false;
  if (job.notification?.state === "sending") job.notification = { state: "ambiguous" };
  for (const [outcome, notification] of Object.entries(job.promotion?.notifications ?? {})) {
    if (notification.state === "sending") job.promotion!.notifications![outcome] = { state: "ambiguous" };
  }
  persistJob(job);
  saveJson(join(ctx.config.root, "promotion-lock-recovery.json"), {
    at: new Date().toISOString(),
    stoppedController: owner,
    readyJob: job.id,
  });
  unlinkSync(join(ctx.config.root, "controller.lock"));
  return true;
}

/** Dead controllers resume only proven ready promotion work; ambiguous model/verification ownership stays held. */
export function lockUpdate(ctx: UpdateContext): () => void {
  mkdirSync(ctx.config.root, { recursive: true, mode: 0o700 });
  const lock: UpdateLock = {
    version: 1,
    pid: process.pid,
    host: hostname(),
    nonce: randomUUID(),
    at: new Date().toISOString(),
  };
  const path = join(ctx.config.root, "controller.lock");
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const owner = readLock(ctx.config.root);
    if (recoverPromotionLock(ctx, owner, lock)) {
      try {
        fd = openSync(path, "wx", 0o600);
      } catch {
        throw new UpdateError("another controller acquired the recovered promotion lock");
      }
    } else {
      throw new UpdateError(
        owner && owner.host === hostname() && !alive(owner.pid)
          ? "interrupted controller lock retained; inspect children, then use update recover --ack-stopped JOB"
          : "another controller owns this updater root",
      );
    }
  }
  try {
    writeFileSync(fd, JSON.stringify(lock));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return () => {
    if (readLock(ctx.config.root)?.nonce !== lock.nonce) throw new UpdateError("controller ownership changed");
    unlinkSync(path);
  };
}
