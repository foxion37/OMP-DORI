import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { fill } from "../../skills/dori-mode/scripts/src/config.ts";
import { recordCommandOutput } from "./command-output.ts";
import { canonical, contains, UpdateError, UpdateInterrupted } from "./config.ts";
import { type Capability, isolatedEnv } from "./environment.ts";
import { nativeAgent } from "./load.ts";
import { nativePromptOptions } from "./native-prompts.ts";
import { readAgentResponse } from "./response.ts";
import { REVIEW_TOOLS, readReviewScope } from "./reviewer-guard.ts";
import { digest } from "./source.ts";
import { persistJob } from "./state.ts";
import type { CommandReceipt, UpdateCommand, UpdateContext, UpdateJob } from "./types.ts";
import { readWorkerScope } from "./worker-guard.ts";

type Guard = { readonly kind: "review" | "worker"; readonly path: string; readonly nonce: string };

const flagValue = (argv: readonly string[], name: string): string | null => {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? null : (argv[at + 1] ?? null);
};

/** Fresh, non-interactive, session-less OMP with explicit isolation flags and the controller's own capability guard. */
function nativeLaunch(
  ctx: UpdateContext,
  job: UpdateJob,
  command: UpdateCommand,
  argv: readonly string[],
  directory: string,
  env: Record<string, string>,
): { readonly argv: string[]; readonly guard: Guard } {
  if (
    argv.some((arg) =>
      /^(?:-e|--extension|--extensions|--trusted-extension|--hook|--profile|--dori-role)(?:=|$)/.test(arg),
    )
  ) {
    throw new UpdateError("automated OMP uses no explicit extension/profile/Dori-role flags");
  }
  const mode = flagValue(argv, "mode");
  if (mode !== null && mode !== "json") {
    throw new UpdateError("automated OMP requires --mode json for final-message evidence");
  }
  const kind = command === ctx.config.reviewer ? "review" : "worker";
  const guard: Guard = { kind, path: join(directory, `${kind}-scope.json`), nonce: randomUUID() };
  const runtime = dirname(env["DORI_CONFIG"]!);
  const options = [
    ...nativePromptOptions(directory, job.candidate, kind, argv),
    "--no-session",
    "--no-title",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-context-files",
    "--no-pty",
    "--wait-async",
    "--cwd",
    job.candidate,
    "--session-dir",
    join(runtime, "sessions"),
    "--config",
    join(runtime, "omp.json"),
  ];
  if (mode === null) options.push("--mode", "json");
  const prefix = kind === "review" ? "REVIEW" : "WORKER";
  env[`DORI_UPDATE_${prefix}_SCOPE`] = guard.path;
  env[`DORI_UPDATE_${prefix}_NONCE`] = guard.nonce;
  env[`DORI_UPDATE_${prefix}_JOB`] = job.id;
  if (kind === "review") {
    if (!job.sourceHash) throw new UpdateError("reviewer needs the exact checked source hash");
    env["DORI_UPDATE_REVIEW_SOURCE"] = job.sourceHash;
    options.push("--no-lsp", "--tools", REVIEW_TOOLS.join(","));
  }
  const file = kind === "review" ? "./reviewer-guard.ts" : "./worker-guard.ts";
  options.push("-e", fileURLToPath(new URL(file, import.meta.url)));
  // Options precede the final {prompt} positional (and a configured "--" separator right before it).
  const at = argv.length - 1 - (argv.at(-2) === "--" ? 1 : 0);
  return { argv: [...argv.slice(0, at), ...options, ...argv.slice(at)], guard };
}

/** Dedicated argv execution: no shell, TTY, stdin approvals, inherited personal state or implicit model. */
export async function runCommand(
  ctx: UpdateContext,
  job: UpdateJob,
  command: UpdateCommand,
  vars: Readonly<Record<string, string>> = {},
  capability: Capability = "check",
): Promise<{ readonly receipt: CommandReceipt; readonly stdout: string }> {
  if (ctx.signal?.aborted) throw new UpdateInterrupted("updater interrupted before command start");
  const ordinal = String(job.commands.length).padStart(3, "0");
  const directory = join(job.directory, "runtime", ordinal);
  // Caches are job-owned and shared by the job's commands so frozen installs are not repeated three times.
  const env = isolatedEnv(ctx, directory, capability, join(job.directory, "cache"));
  const runtime = dirname(env["DORI_CONFIG"]!);
  const template = {
    ...vars,
    candidate: job.candidate,
    job: job.id,
    agentConfig: join(runtime, "omp.json"),
    sessions: join(runtime, "sessions"),
  };
  let argv = fill(command.argv, template);
  const native = capability === "model" && nativeAgent(command);
  let guard: Guard | undefined;
  if (native) ({ argv, guard } = nativeLaunch(ctx, job, command, argv, directory, env));
  const cwd = canonical(resolve(job.candidate, command.cwd ?? "."));
  if (!contains(canonical(job.candidate), cwd)) throw new UpdateError("command cwd escaped candidate");
  const logs = join(job.directory, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const out = join(logs, `${ordinal}.stdout`);
  const err = join(logs, `${ordinal}.stderr`);
  const receipt: CommandReceipt = {
    name: command.name,
    argvHash: digest(JSON.stringify(argv)),
    startedAt: new Date().toISOString(),
    stdout: out,
    stderr: err,
    ...(job.sourceHash === undefined ? {} : { sourceHash: job.sourceHash }),
    ...(guard?.kind === "review" ? { reviewScopePath: guard.path } : {}),
    ...(guard?.kind === "worker" ? { workerScopePath: guard.path } : {}),
    ...(capability === "model"
      ? {
          model: {
            requested: flagValue(argv, "model"),
            observed: null,
            requestedThinking: flagValue(argv, "thinking"),
          },
        }
      : {}),
  };
  job.commands.push(receipt);
  persistJob(job);
  const secrets = [...ctx.config.modelEnv, ...ctx.config.reporterEnv]
    .map((name) => process.env[name])
    .filter((value): value is string => !!value)
    .sort((left, right) => right.length - left.length);
  const redact = (message: string): string =>
    secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), message);
  let proc: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let interrupted = false;
  try {
    proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    receipt.pid = proc.pid;
    persistJob(job);
    await recordCommandOutput(proc, receipt, secrets, command.timeoutMs, ctx.signal);
  } catch (error) {
    if (proc?.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    interrupted = proc !== undefined;
    receipt.error = redact(error instanceof Error ? error.message : String(error));
  } finally {
    receipt.finishedAt = new Date().toISOString();
    persistJob(job);
  }
  if (interrupted || ctx.signal?.aborted) {
    throw new UpdateInterrupted(
      `command ${command.name} interrupted; inspect its private receipt and logs before recover --ack-stopped`,
    );
  }
  if (receipt.error !== undefined || receipt.signal !== undefined || receipt.exitCode !== 0) {
    throw new UpdateError(`command ${command.name} failed; inspect its private receipt and logs`);
  }
  const stdout = readFileSync(out, "utf8");
  if (!native) return { receipt, stdout };
  const response = readAgentResponse(stdout);
  if (receipt.model) {
    receipt.model.observed = response.observedModel;
    persistJob(job);
    if (receipt.model.requested !== response.observedModel) {
      throw new UpdateError("OMP observed model differs from the exact requested model; candidate held");
    }
  }
  if (guard) {
    try {
      if (guard.kind === "review") {
        receipt.reviewScope = readReviewScope(guard.path, {
          nonce: guard.nonce,
          job: job.id,
          sourceHash: job.sourceHash ?? "",
          pid: receipt.pid ?? 0,
        });
      } else {
        receipt.workerScope = readWorkerScope(guard.path, { nonce: guard.nonce, job: job.id, pid: receipt.pid ?? 0 });
      }
    } catch {
      throw new UpdateInterrupted(`native ${guard.kind} did not establish its exact runtime tool scope`);
    }
    persistJob(job);
  }
  return { receipt, stdout: response.text };
}
