import { chmodSync, copyFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { alive } from "../../skills/dori-mode/scripts/src/checkpoint-lock.ts";
import { applicationInput, applicationManifest, freezeApplicationState, restoreApplicationState } from "./app-state.ts";
import { canonical, contains, object, UpdateError } from "./config.ts";
import { candidateReport } from "./report.ts";
import { assertSource, digest, freezeSource, sameManifest, sourceManifest } from "./source.ts";
import { lockUpdate, persistJob, persistState, readJob, readLock, readState, saveJson, transition } from "./state.ts";
import type { SourceManifest, UpdateContext, UpdateJob } from "./types.ts";

type RecoveryManifest = {
  readonly version: 1;
  readonly target: "dori";
  readonly job: string;
  readonly source: SourceManifest;
  readonly inputs: Readonly<Record<string, SourceManifest>>;
  readonly applicationState: SourceManifest | null;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
};

const FINISHED = ["ready", "failed", "rejected"] as const;
const CONTROL_FILE = /^(?:task-state\/(?:state|job|report|inputs)\.json|receipts\/\d+\.(?:json|stdout|stderr))$/;

/** Explicit stopped-child acknowledgement clears ownership while retaining exact-SHA dedup and promotion intent. */
export function acknowledgeStopped(ctx: UpdateContext, id: string): UpdateJob | undefined {
  const lock = readLock(ctx.config.root);
  if (lock && (lock.host !== hostname() || alive(lock.pid))) {
    throw new UpdateError("controller is alive or belongs to another host; recovery held");
  }
  const state = readState(ctx);
  const release = (): void => {
    if (lock && readLock(ctx.config.root)?.nonce === lock.nonce) unlinkSync(join(ctx.config.root, "controller.lock"));
  };
  if (id === "none" && state.active === undefined) {
    if (!lock) throw new UpdateError("there is no interrupted controller lock to acknowledge");
    saveJson(join(ctx.config.root, "recovery-ack.json"), {
      at: new Date().toISOString(),
      stoppedController: lock,
      activeJob: null,
    });
    release();
    ctx.emit({ type: "DORI_UPDATE", target: "dori", event: "recovered-idle-controller" });
    return undefined;
  }
  if (state.active !== id) throw new UpdateError("acknowledgement must name the exact active job");
  const job = readJob(ctx.config.root, id);
  if (job.notification?.state === "sending") job.notification = { state: "ambiguous" };
  for (const [outcome, notification] of Object.entries(job.promotion?.notifications ?? {})) {
    if (notification.state === "sending") job.promotion!.notifications![outcome] = { state: "ambiguous" };
  }
  if (FINISHED.some((phase) => phase === job.phase)) {
    // The controller stopped after a complete verdict: keep it, unless a ready verdict no longer matches its source.
    try {
      if (job.phase === "ready") assertSource(job);
      persistJob(job);
    } catch (error) {
      job.problem = error instanceof Error ? error.message : String(error);
      if (ctx.config.promotion && job.phase === "ready") {
        job.promotion ??= { version: 1, status: "held" };
        job.promotion.status = "held";
        job.promotion.problem = job.problem;
        persistJob(job);
      } else transition(ctx, job, "failed");
    }
  } else {
    job.problem = "operator acknowledged all old child processes stopped; no automatic retry or readiness restored";
    transition(ctx, job, "interrupted");
  }
  state.processed = job.upstream;
  delete state.active;
  persistState(ctx, state);
  release();
  return job;
}

function newDestination(ctx: UpdateContext, value: string, ...inputs: readonly string[]): string {
  const path = canonical(resolve(value));
  for (const protectedPath of [ctx.config.root, canonical(ctx.config.localSource), ...inputs]) {
    if (contains(path, protectedPath) || contains(protectedPath, path)) {
      throw new UpdateError(
        "recovery output must be a fresh directory separate from source, state and snapshot inputs",
      );
    }
  }
  try {
    mkdirSync(path, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new UpdateError("recovery output already exists; choose a new path (nothing is overwritten)");
    }
    throw error;
  }
  return path;
}

/**
 * Snapshot code, updater-owned control evidence and, only when named, explicit task-owned application data.
 * No personal auth, model sessions, installed packages or live state is ever read; admitted ULW source stays frozen.
 */
export function snapshotUpdate(ctx: UpdateContext, id: string, output: string, appState?: string): string {
  const release = lockUpdate(ctx);
  try {
    const state = readState(ctx);
    if (state.active !== undefined)
      throw new UpdateError("snapshot held while a job has active or ambiguous processes");
    const job = readJob(ctx.config.root, id);
    if (job.phase === "ready") assertSource(job);
    const app = appState === undefined ? undefined : applicationInput(ctx, job, appState);
    const directory = newDestination(ctx, output, ...(app === undefined ? [] : [app]));
    const source = freezeSource(job.candidate, join(directory, "source"));
    const applicationState = app === undefined ? null : freezeApplicationState(app, join(directory, "app-state"));
    const inputs: Record<string, SourceManifest> = {};
    if (job.inputs) {
      mkdirSync(join(directory, "inputs"), { mode: 0o700 });
      for (const name of ["base", "local", "upstream"]) {
        inputs[name] = freezeSource(join(job.directory, "inputs", name), join(directory, "inputs", name));
      }
    }
    mkdirSync(join(directory, "task-state"), { mode: 0o700 });
    saveJson(join(directory, "task-state", "state.json"), state);
    saveJson(join(directory, "task-state", "job.json"), job);
    saveJson(join(directory, "task-state", "report.json"), candidateReport(ctx, job));
    const files = ["state.json", "job.json", "report.json"].map((name) => `task-state/${name}`);
    if (job.inputs) {
      saveJson(join(directory, "task-state", "inputs.json"), job.inputs);
      files.push("task-state/inputs.json");
    }
    mkdirSync(join(directory, "receipts"), { mode: 0o700 });
    for (const [index, receipt] of job.commands.entries()) {
      saveJson(join(directory, "receipts", `${index}.json`), receipt);
      files.push(`receipts/${index}.json`);
      if (!receipt.finishedAt || receipt.error) continue;
      for (const channel of ["stdout", "stderr"] as const) {
        const relative = `receipts/${index}.${channel}`;
        copyFileSync(receipt[channel], join(directory, relative));
        files.push(relative);
      }
    }
    const manifest: RecoveryManifest = {
      version: 1,
      target: "dori",
      job: id,
      source,
      inputs,
      applicationState,
      files: files.map((path) => ({ path, sha256: digest(readFileSync(join(directory, path))) })),
    };
    saveJson(join(directory, "snapshot.json"), manifest);
    return directory;
  } finally {
    release();
  }
}

function readSnapshot(input: string): RecoveryManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(input, "snapshot.json"), "utf8"));
  } catch {
    raw = undefined;
  }
  if (
    !object(raw) ||
    raw["version"] !== 1 ||
    raw["target"] !== "dori" ||
    typeof raw["job"] !== "string" ||
    !object(raw["source"]) ||
    !object(raw["inputs"]) ||
    !Array.isArray(raw["files"]) ||
    !(raw["applicationState"] === null || object(raw["applicationState"]))
  ) {
    throw new UpdateError("invalid Dori recovery snapshot");
  }
  return raw as unknown as RecoveryManifest;
}

/** Restore only into a NEW isolated directory. Archived passed checks/review never become restored readiness. */
export function restoreUpdate(ctx: UpdateContext, snapshot: string, output: string): string {
  const input = canonical(resolve(snapshot));
  const manifest = readSnapshot(input);
  const source = sourceManifest(join(input, "source"));
  if (!sameManifest(source, manifest.source)) throw new UpdateError("recovery source hash mismatch");
  if (
    manifest.applicationState !== null &&
    !sameManifest(applicationManifest(join(input, "app-state")), manifest.applicationState)
  ) {
    throw new UpdateError("recovery application-state hash mismatch");
  }
  for (const [name, expected] of Object.entries(manifest.inputs)) {
    if (
      !["base", "local", "upstream"].includes(name) ||
      !sameManifest(sourceManifest(join(input, "inputs", name)), expected)
    ) {
      throw new UpdateError("recovery frozen-input hash mismatch");
    }
  }
  for (const required of ["task-state/state.json", "task-state/job.json", "task-state/report.json"]) {
    if (!manifest.files.some((file) => file.path === required))
      throw new UpdateError("recovery snapshot lacks required control state");
  }
  for (const file of manifest.files) {
    if (!CONTROL_FILE.test(file.path) || digest(readFileSync(join(input, file.path))) !== file.sha256) {
      throw new UpdateError("recovery control-state/receipt hash mismatch");
    }
  }
  const directory = newDestination(ctx, output, input);
  freezeSource(join(input, "source"), join(directory, "candidate"));
  for (const file of source.files) chmodSync(join(directory, "candidate", file.path), file.executable ? 0o700 : 0o600);
  if (manifest.applicationState !== null) {
    restoreApplicationState(join(input, "app-state"), join(directory, "app-state"), manifest.applicationState);
  }
  mkdirSync(join(directory, "inputs"), { mode: 0o700 });
  for (const name of Object.keys(manifest.inputs))
    freezeSource(join(input, "inputs", name), join(directory, "inputs", name));
  for (const file of manifest.files) {
    const path = join(directory, "archive", file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, readFileSync(join(input, file.path)), { flag: "wx", mode: 0o600 });
  }
  const state: unknown = JSON.parse(readFileSync(join(input, "task-state", "state.json"), "utf8"));
  const job: unknown = JSON.parse(readFileSync(join(input, "task-state", "job.json"), "utf8"));
  if (!object(state) || !object(job)) throw new UpdateError("recovery control state is malformed");
  saveJson(join(directory, "state.json"), {
    version: 1,
    restoredFrom: manifest.job,
    phase: "interrupted",
    archivedState: state,
    candidateOnly: true,
  });
  saveJson(join(directory, "job.json"), {
    ...job,
    phase: "interrupted",
    candidate: join(directory, "candidate"),
    problem: "restored recovery copy; archived checks/review are historical and grant no readiness",
  });
  saveJson(join(directory, "recovery.json"), {
    version: 1,
    target: "dori",
    phase: "interrupted",
    sourceHash: manifest.source.hash,
    applicationStateHash: manifest.applicationState?.hash ?? null,
    applicationState: manifest.applicationState === null ? null : join(directory, "app-state"),
    snapshotJob: manifest.job,
    candidateOnly: true,
  });
  return directory;
}
