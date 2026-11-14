import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { saveDeploymentJson } from "./deployment-files.ts";
import { captureHandoff } from "./deployment-handoff.ts";
import { command, DeploymentHeld } from "./deployment-process.ts";
import type { DeploymentConfig, DeploymentRecord } from "./deployment-types.ts";
import { digest, sourceManifest } from "./source.ts";

export function readRestartIntent(config: DeploymentConfig): DeploymentRecord | undefined {
  const path = join(config.releaseRoot, "restart-pending.json");
  if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
  const intent = JSON.parse(readFileSync(path, "utf8")) as { id: string; directory: string; configHash: string };
  if (
    !/^restart-[a-f0-9-]+$/.test(intent.id) ||
    intent.directory !== join(config.releaseRoot, "transactions", intent.id) ||
    intent.configHash !== digest(JSON.stringify(config))
  )
    throw new DeploymentHeld("pending restart intent differs");
  const record = JSON.parse(readFileSync(join(intent.directory, "deployment.json"), "utf8")) as DeploymentRecord;
  if (
    record.id !== intent.id ||
    record.directory !== intent.directory ||
    record.configHash !== intent.configHash ||
    !record.oldRuntime
  )
    throw new DeploymentHeld("pending restart journal differs");
  return record;
}

export function saveRestartIntent(config: DeploymentConfig, record: DeploymentRecord): void {
  saveDeploymentJson(join(record.directory, "deployment.json"), record);
  saveDeploymentJson(join(config.releaseRoot, "restart-pending.json"), {
    id: record.id,
    directory: record.directory,
    configHash: record.configHash,
  });
}

export function finishRestartIntent(config: DeploymentConfig, record: DeploymentRecord): void {
  const pending = readRestartIntent(config);
  if (
    pending?.id !== record.id ||
    pending.status !== record.status ||
    pending.step !== "done" ||
    (pending.status !== "healthy" && pending.status !== "rolled-back")
  )
    throw new DeploymentHeld("completed restart no longer owns a verified terminal intent");
  renameSync(join(config.releaseRoot, "restart-pending.json"), join(record.directory, "completed-intent.json"));
}

/** A busy admission race has no runtime effects; preserve it without blocking a future idle attempt. */
export function deferRestartIntent(config: DeploymentConfig, record: DeploymentRecord): void {
  const pending = readRestartIntent(config);
  if (
    pending?.id !== record.id ||
    pending.status !== "held" ||
    pending.step !== "stop" ||
    pending.stopRequestedAt ||
    record.stopRequestedAt ||
    record.launchRequestedAt
  )
    throw new DeploymentHeld("busy restart intent has runtime effects");
  renameSync(join(config.releaseRoot, "restart-pending.json"), join(record.directory, "deferred-intent.json"));
}

export async function newRestartIntent(config: DeploymentConfig, signal?: AbortSignal): Promise<DeploymentRecord> {
  const source = realpathSync(config.liveSource);
  const manifest = sourceManifest(source);
  const id = `restart-${randomUUID()}`;
  const directory = join(config.releaseRoot, "transactions", id);
  mkdirSync(directory, { mode: 0o700 });
  const identity = (
    await command(
      ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "rev-parse", "HEAD", "HEAD^{tree}"],
      source,
      {
        PATH: "/usr/bin:/bin",
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      10_000,
      signal,
    )
  ).split("\n");
  if (identity.length !== 2 || identity.some((sha) => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)))
    throw new DeploymentHeld("current source commit identity is unavailable");
  const record: DeploymentRecord = {
    version: 1,
    id,
    directory,
    releasePath: source,
    sourceHash: manifest.hash,
    commit: identity[0]!,
    tree: identity[1]!,
    configHash: digest(JSON.stringify(config)),
    inputHash: digest(JSON.stringify({ source: manifest.hash, session: config.sessionId })),
    createdAt: new Date().toISOString(),
    status: "prepared",
    step: "prepare",
    preparedAt: new Date().toISOString(),
  };
  await captureHandoff(config, record);
  return record;
}
