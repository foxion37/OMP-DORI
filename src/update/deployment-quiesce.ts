import { lstatSync, readFileSync, renameSync } from "node:fs";
import { DeploymentBusy, DeploymentHeld } from "./deployment-process.ts";
import type { DeploymentConfig, DeploymentRecord, RuntimeIdentity } from "./deployment-types.ts";
import { digest } from "./source.ts";

/** One explicit initial self-handoff checkpoint; never an ambient permission to interrupt a busy actor. */
export function verifyQuiesceCheckpoint(
  config: DeploymentConfig,
  record: DeploymentRecord,
  runtime: RuntimeIdentity,
): void {
  if (!config.quiesceCheckpointFile) throw new DeploymentBusy("native Dori is busy; waiting for its idle boundary");
  const consumed = `${config.quiesceCheckpointFile}.consumed-${record.id}`;
  const path =
    record.quiesceHash && lstatSync(consumed, { throwIfNoEntry: false }) ? consumed : config.quiesceCheckpointFile;
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) throw new DeploymentBusy("native Dori is busy; waiting for its explicit quiesce checkpoint");
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw new DeploymentHeld("quiesce checkpoint must be private and owned");
  const raw = readFileSync(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    throw new DeploymentHeld("invalid quiesce checkpoint");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new DeploymentHeld("invalid quiesce checkpoint");
  const value = parsed as Record<string, unknown>;
  const hash = digest(raw);
  const expires = typeof value["expiresAt"] === "string" ? Date.parse(value["expiresAt"]) : NaN;
  if (
    value["version"] !== 1 ||
    value["deploymentId"] !== record.id ||
    value["commit"] !== record.commit ||
    value["sourceHash"] !== record.sourceHash ||
    value["pane"] !== runtime.pane ||
    value["sessionId"] !== runtime.sessionId ||
    value["pid"] !== runtime.pid ||
    value["startTicks"] !== runtime.startTicks ||
    value["bootId"] !== runtime.bootId ||
    value["startedAt"] !== runtime.startedAt ||
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + 300_000 ||
    (record.quiesceHash !== undefined && record.quiesceHash !== hash)
  )
    throw new DeploymentHeld("quiesce checkpoint does not bind this deployment and native identity");
  record.quiesceHash = hash;
}

/** Consume the admitted one-shot file by owned rename; later jobs never inherit a stale busy override. */
export function consumeQuiesceCheckpoint(config: DeploymentConfig, record: DeploymentRecord): void {
  if (!record.quiesceHash || !config.quiesceCheckpointFile) return;
  const consumed = `${config.quiesceCheckpointFile}.consumed-${record.id}`;
  if (lstatSync(consumed, { throwIfNoEntry: false })) {
    if (digest(readFileSync(consumed)) !== record.quiesceHash)
      throw new DeploymentHeld("consumed quiesce receipt differs");
    return;
  }
  if (digest(readFileSync(config.quiesceCheckpointFile)) !== record.quiesceHash)
    throw new DeploymentHeld("quiesce checkpoint changed before consumption");
  renameSync(config.quiesceCheckpointFile, consumed);
  if (digest(readFileSync(consumed)) !== record.quiesceHash)
    throw new DeploymentHeld("consumed quiesce receipt differs");
}
