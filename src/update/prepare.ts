import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateDetectionUnavailable, UpdateError, UpdateInterrupted } from "./config.ts";
import { type DetectionReceipt, runDetectorProcess } from "./detection-process.ts";
import { isolatedEnv } from "./environment.ts";
import { runCommand } from "./process.ts";
import { carryDoriPin, changedPaths, digest, freezeSource, sourceManifest } from "./source.ts";
import { persistJob, saveJson } from "./state.ts";
import type { UpdateContext, UpdateJob } from "./types.ts";

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Only this configured full ref is observed; never an implicit HEAD, another repository or a live installation. */
export async function detectHead(ctx: UpdateContext, timeoutMs = 60_000): Promise<string> {
  if (ctx.signal?.aborted) throw new UpdateInterrupted("detector interrupted before launch");
  const directory = join(ctx.config.root, "detector");
  const env = isolatedEnv(ctx, directory, "check");
  const argv = [
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "http.lowSpeedLimit=1",
    "-c",
    "http.lowSpeedTime=30",
    "ls-remote",
    "--exit-code",
    "--refs",
    "--",
    ctx.config.remote,
    ctx.config.ref,
  ];
  const invocation = randomUUID();
  const receiptPath = join(directory, `${invocation}.json`);
  const localCommandReceipt: DetectionReceipt = {
    name: "detect-head",
    argvHash: digest(JSON.stringify(argv)),
    startedAt: new Date().toISOString(),
    stdout: join(directory, `${invocation}.stdout`),
    stderr: join(directory, `${invocation}.stderr`),
  };
  saveJson(receiptPath, localCommandReceipt);
  let interrupted = false;
  try {
    await runDetectorProcess(
      argv,
      directory,
      env,
      localCommandReceipt,
      (pid) => {
        localCommandReceipt.pid = pid;
        saveJson(receiptPath, localCommandReceipt);
        saveJson(join(directory, "detection-started.json"), {
          at: localCommandReceipt.startedAt,
          pid,
          receiptPath,
        });
      },
      timeoutMs,
      ctx.signal,
    );
  } catch (error) {
    interrupted = error instanceof UpdateInterrupted;
    localCommandReceipt.error = error instanceof Error ? error.message : String(error);
  } finally {
    localCommandReceipt.finishedAt = new Date().toISOString();
    saveJson(receiptPath, localCommandReceipt);
    saveJson(join(directory, "last-detection.json"), { ...localCommandReceipt, receiptPath });
  }
  if (interrupted || ctx.signal?.aborted) {
    throw new UpdateInterrupted(
      "detector interrupted; inspect detector/last-detection.json and verify descendants stopped before another attempt",
    );
  }
  if (
    localCommandReceipt.error !== undefined ||
    localCommandReceipt.exitCode !== 0 ||
    localCommandReceipt.signal !== undefined
  ) {
    throw new UpdateDetectionUnavailable("Dori ref detection unavailable; inspect detector/last-detection.json");
  }
  const stdout = readFileSync(localCommandReceipt.stdout, "utf8");
  const rows = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/));
  const [sha, ref] = rows[0] ?? [];
  if (rows.length !== 1 || ref !== ctx.config.ref || !sha || !SHA.test(sha)) {
    throw new UpdateError("configured Dori ref did not resolve to exactly one pinned SHA");
  }
  return sha;
}

/** Two independent ordinary clones (pinned new upstream and exact base), then frozen source inputs. No worktrees. */
export async function prepareCandidate(ctx: UpdateContext, job: UpdateJob): Promise<void> {
  mkdirSync(job.candidate, { mode: 0o700 });
  const safe = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
  ];
  const git = async (step: string, argv: readonly string[]): Promise<string> =>
    (
      await runCommand(ctx, job, { name: `prepare:${step}`, argv: ["git", ...safe, ...argv], timeoutMs: 300_000 })
    ).stdout.trim();
  // Only the opaque local ULW pin is carried below; all Dori code starts from exact new upstream.
  await git("clone-upstream", ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--", ctx.config.remote, "."]);
  await git("fetch-pinned-upstream", ["fetch", "--no-auto-maintenance", "--no-tags", "origin", job.upstream]);
  await git("materialize-pinned-upstream", ["checkout", "--detach", job.upstream]);
  if ((await git("confirm-pinned-upstream", ["rev-parse", "HEAD"])) !== job.upstream) {
    throw new UpdateError("candidate clone did not materialize the pinned SHA");
  }
  const pkg: unknown = JSON.parse(readFileSync(join(job.candidate, "package.json"), "utf8"));
  const dori = existsSync(join(job.candidate, "skills", "dori-mode", "scripts", "src", "cli.ts"));
  if (typeof pkg !== "object" || pkg === null || Reflect.get(pkg, "name") !== "dori-superagent" || !dori) {
    throw new UpdateError("configured remote is not the Dori source distribution");
  }
  const baseRepo = join(job.directory, "base-upstream");
  await git("clone-base", [
    "clone",
    "--no-local",
    "--no-hardlinks",
    "--no-checkout",
    "--",
    ctx.config.remote,
    baseRepo,
  ]);
  await git("fetch-pinned-base", [
    "-C",
    baseRepo,
    "fetch",
    "--no-auto-maintenance",
    "--no-tags",
    "origin",
    job.baseUpstream,
  ]);
  await git("materialize-pinned-base", ["-C", baseRepo, "checkout", "--detach", job.baseUpstream]);
  if ((await git("confirm-pinned-base", ["-C", baseRepo, "rev-parse", "HEAD"])) !== job.baseUpstream) {
    throw new UpdateError("base clone did not materialize baseUpstream");
  }
  const inputs = join(job.directory, "inputs");
  mkdirSync(inputs, { mode: 0o700 });
  const base = freezeSource(baseRepo, join(inputs, "base"), "upstream");
  const local = freezeSource(ctx.config.localSource, join(inputs, "local"), "local");
  const incoming = freezeSource(job.candidate, join(inputs, "upstream"), "upstream");
  job.inputs = {
    baseUpstream: job.baseUpstream,
    upstream: job.upstream,
    base,
    local,
    incoming,
    changedPaths: changedPaths(base, local, incoming),
  };
  saveJson(join(inputs, "manifest.json"), job.inputs);
  carryDoriPin(join(inputs, "local"), job.candidate, local);
  saveJson(join(job.directory, "prepared-source.json"), sourceManifest(job.candidate));
  persistJob(job);
}
