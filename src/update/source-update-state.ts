import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { owned } from "../release/files.ts";
import { object } from "./config.ts";
import { saveDeploymentJson } from "./deployment-files.ts";
import { DeploymentHeld } from "./deployment-process.ts";
import { forwardStopStarted } from "./deployment-stop.ts";
import type { DeploymentInput, DeploymentRecord } from "./deployment-types.ts";
import { digest } from "./source.ts";
import type { SourceUpdateConfig } from "./source-update-config.ts";
import type { SourceSnapshot } from "./source-update-git.ts";
import type { SourceTarget } from "./source-update-target.ts";

export type SourceJob = {
  createdAt: string;
  repository: string;
  deploymentConfigHash: string;
  current: SourceSnapshot;
  target: SourceTarget;
  input: DeploymentInput;
  deployment?: DeploymentRecord;
};
export type SourceUpdateState = { version: 1; job?: SourceJob; failedCommits?: string[] };
const sha = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value);
const file = (config: SourceUpdateConfig) => join(config.deployment.releaseRoot, "source-update.json");

/** Held pre-effect attempts may be superseded, but a newer inner exit receipt always wins. */
export function sourceRecoveryPending(job: SourceJob): boolean {
  let deployment = job.deployment;
  if (!deployment) return true;
  const path = join(deployment.directory, "deployment.json");
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new DeploymentHeld("source recovery journal is not a regular file");
      owned(path);
      const durable: unknown = JSON.parse(readFileSync(path, "utf8"));
      const keys = [
        "id",
        "inputHash",
        "configHash",
        "directory",
        "releasePath",
        "commit",
        "tree",
        "sourceHash",
      ] as const;
      if (!object(durable) || keys.some((key) => durable[key] !== deployment![key]))
        throw new DeploymentHeld("source recovery journal identity differs");
      deployment = durable as DeploymentRecord;
    }
  } catch (error) {
    if (error instanceof DeploymentHeld) throw error;
    throw new DeploymentHeld("source recovery journal is unavailable", { cause: error });
  }
  if (deployment.status === "healthy" || deployment.status === "rolled-back")
    return deployment.status !== job.deployment?.status;
  return !(
    deployment.status === "held" &&
    !forwardStopStarted(deployment) &&
    (deployment.step === "prepare" || deployment.step === "stop")
  );
}

export function readSourceState(config: SourceUpdateConfig): SourceUpdateState {
  const path = file(config);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { version: 1 };
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DeploymentHeld("source update state must be a regular file");
  owned(path);
  return parseSourceState(config, JSON.parse(readFileSync(path, "utf8")));
}

export function parseSourceState(config: SourceUpdateConfig, value: unknown): SourceUpdateState {
  if (
    !object(value) ||
    value["version"] !== 1 ||
    Object.keys(value).some((key) => !["version", "job", "failedCommits"].includes(key)) ||
    (value["failedCommits"] !== undefined &&
      (!Array.isArray(value["failedCommits"]) ||
        value["failedCommits"].some((commit: unknown) => !sha(commit, 40)) ||
        new Set(value["failedCommits"]).size !== value["failedCommits"].length))
  )
    throw new DeploymentHeld("source update state is invalid");
  const job = value["job"];
  if (job === undefined) return value as SourceUpdateState;
  if (
    !object(job) ||
    typeof job["createdAt"] !== "string" ||
    !Number.isFinite(Date.parse(job["createdAt"])) ||
    typeof job["repository"] !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(job["repository"]) ||
    !sha(job["deploymentConfigHash"], 64) ||
    !object(job["current"]) ||
    !object(job["target"]) ||
    !object(job["input"])
  )
    throw new DeploymentHeld("source update intent is invalid");
  const current = job["current"],
    target = job["target"],
    input = job["input"];
  if (
    !absolute(current["path"]) ||
    !sha(current["commit"], 40) ||
    !sha(current["tree"], 40) ||
    !sha(current["sourceHash"], 64) ||
    !sha(target["commit"], 40) ||
    !sha(target["tree"], 40) ||
    !sha(target["main"], 40) ||
    typeof target["ahead"] !== "number" ||
    !Number.isSafeInteger(target["ahead"]) ||
    target["ahead"] < 1 ||
    !object(target["ci"]) ||
    ![target["ci"]["id"], target["ci"]["attempt"]].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0,
    ) ||
    input["remote"] !== `https://github.com/${job["repository"]}.git` ||
    input["commit"] !== target["commit"] ||
    input["tree"] !== target["tree"] ||
    !sha(input["sourceHash"], 64) ||
    input["candidate"] !== join(config.deployment.releaseRoot, "source-candidates", target["commit"]) ||
    !object(input["publicManifest"]) ||
    input["publicManifest"]["hash"] !== input["sourceHash"]
  )
    throw new DeploymentHeld("source update target or candidate identity is invalid");
  const deployment = job["deployment"];
  if (deployment !== undefined) {
    if (
      !object(deployment) ||
      deployment["version"] !== 1 ||
      typeof deployment["id"] !== "string" ||
      !/^[A-Za-z0-9-]+$/.test(deployment["id"]) ||
      deployment["inputHash"] !== digest(JSON.stringify(input)) ||
      deployment["configHash"] !== job["deploymentConfigHash"] ||
      deployment["commit"] !== target["commit"] ||
      deployment["tree"] !== target["tree"] ||
      deployment["sourceHash"] !== input["sourceHash"] ||
      deployment["directory"] !== join(config.deployment.releaseRoot, "transactions", deployment["id"]) ||
      deployment["releasePath"] !==
        join(config.deployment.releaseRoot, "releases", `${target["commit"]}-${input["sourceHash"].slice(0, 16)}`) ||
      !["prepared", "stopping", "switching", "starting", "healthy", "rolled-back", "held", "failed"].includes(
        String(deployment["status"]),
      ) ||
      !["prepare", "stop", "switch", "start", "health", "rollback", "done"].includes(String(deployment["step"])) ||
      (deployment["stopRequestedAt"] !== undefined &&
        (typeof deployment["stopRequestedAt"] !== "string" ||
          !Number.isFinite(Date.parse(deployment["stopRequestedAt"]))))
    )
      throw new DeploymentHeld("source deployment receipt is invalid");
  }
  return value as SourceUpdateState;
}

export function saveSourceState(config: SourceUpdateConfig, state: SourceUpdateState): void {
  saveDeploymentJson(file(config), state);
}
