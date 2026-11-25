import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeploymentConfig, ProcessIdentity, ToolchainReceipt } from "./deployment-types.ts";
import { bootId, procExe, procExeTarget, procStat } from "./proc.ts";

export class DeploymentHeld extends Error {}
export class DeploymentBusy extends DeploymentHeld {}
export class DeploymentRetryable extends DeploymentHeld {}
export const processIdentity = (pid: number): ProcessIdentity | undefined => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const { startTicks, zombie } = procStat(pid);
    if (!startTicks || !/^\d+$/.test(startTicks) || zombie) return undefined;
    const image = statSync(procExe(pid), { bigint: true });
    return {
      pid,
      startTicks,
      bootId: bootId(),
      executable: procExeTarget(pid),
      imageDev: image.dev.toString(),
      imageIno: image.ino.toString(),
    };
  } catch {
    return undefined;
  }
};
export function sameProcess(expected: ProcessIdentity, current = processIdentity(expected.pid)): boolean {
  const sameImage =
    expected.imageDev !== undefined && expected.imageIno !== undefined
      ? expected.imageDev === current?.imageDev && expected.imageIno === current?.imageIno
      : expected.executable === current?.executable;
  return (
    current !== undefined &&
    expected.pid === current.pid &&
    expected.startTicks === current.startTicks &&
    expected.bootId === current.bootId &&
    sameImage
  );
}

export function underProcess(pid: number, root: number): boolean {
  const seen = new Set<number>();
  try {
    for (let at = pid; at > 1 && !seen.has(at);) {
      if (at === root) return true;
      seen.add(at);
      at = procStat(at).ppid;
    }
  } catch {
    return false;
  }
  return false;
}

/** The prepared parent and its descendants use the same fence and pinned Cataly extension. */
export function managedOmpCommand(toolchain: ToolchainReceipt, source: string | undefined): readonly string[] {
  if (source !== toolchain.extensionSource)
    throw new DeploymentHeld("managed extension source differs from its prepared toolchain");
  return [toolchain.omp, "--config", toolchain.nativeConfig, "--no-extensions", "-e", join(source, "extension")];
}

/** No caller environment, tokens, sudo context or global Bun policy enters a prepared release/native actor. */
export function actorEnv(config: DeploymentConfig, toolchain?: ToolchainReceipt): Record<string, string> {
  return {
    HOME: config.home,
    PATH: [
      dirname(toolchain?.bun ?? config.bun),
      dirname(toolchain?.omp ?? config.omp ?? join(config.catalyHome, "bin/omp")),
      join(config.catalyHome, "bin"),
      join(config.home, ".bun", "bin"),
      "/usr/bin",
      "/bin",
    ].join(":"),
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    CATALY_HOME: config.catalyHome,
    CATALY_CONFIG: config.catalyConfig,
    CATALY_STATE_DIR: config.stateDir,
    ...(toolchain
      ? { CATALY_AGENT_ARGV: JSON.stringify(managedOmpCommand(toolchain, toolchain.extensionSource)) }
      : {}),
    CATALY_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  };
}

export async function command(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
  input?: string,
): Promise<string> {
  if (signal?.aborted) throw new DeploymentHeld("deployment interrupted before command");
  if (!argv[0]) throw new Error("deployment command is empty");
  const options = { cwd, env, detached: true };
  const proc =
    input === undefined
      ? spawn(argv[0], argv.slice(1), { ...options, stdio: ["ignore", "pipe", "ignore"] })
      : spawn(argv[0], argv.slice(1), { ...options, stdio: ["pipe", "pipe", "ignore"] });
  let inputFailed = false;
  if (proc.stdin) {
    proc.stdin.on("error", () => {
      inputFailed = true;
    });
    proc.stdin.end(input);
  }
  let interrupted = false;
  const chunks: Buffer[] = [];
  proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const stop = (): void => {
    interrupted = true;
    if (proc.pid === undefined) return;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const { promise, resolve, reject } = Promise.withResolvers<number | null>();
    proc.once("error", () => reject(new DeploymentRetryable("deployment command did not start")));
    proc.once("close", resolve);
    const code = await promise;
    if (interrupted) {
      if (signal?.aborted) throw new DeploymentHeld("deployment command interrupted");
      throw new DeploymentRetryable("deployment command timed out");
    }
    if (code !== 0 || inputFailed)
      throw new DeploymentRetryable("deployment command failed; operator data and credentials were not captured");
    return Buffer.concat(chunks).toString().trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/** Recover only a provably dead holder. Unknown ownership remains held, regardless of age. */
export function acquireRestartLock(config: Pick<DeploymentConfig, "restartLock">): () => void {
  mkdirSync(dirname(config.restartLock), { recursive: true, mode: 0o700 });
  const own = processIdentity(process.pid);
  if (!own) throw new DeploymentHeld("deployment process identity is unavailable");
  const claim = (): void => {
    mkdirSync(config.restartLock, { mode: 0o700 });
    writeFileSync(join(config.restartLock, "owner.json"), JSON.stringify(own), { flag: "wx", mode: 0o600 });
  };
  try {
    claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let holder: ProcessIdentity;
    try {
      holder = JSON.parse(readFileSync(join(config.restartLock, "owner.json"), "utf8")) as ProcessIdentity;
    } catch {
      throw new DeploymentRetryable("restart lock ownership is unknown");
    }
    if (
      !Number.isSafeInteger(holder.pid) ||
      typeof holder.startTicks !== "string" ||
      typeof holder.bootId !== "string" ||
      typeof holder.executable !== "string" ||
      sameProcess(holder)
    )
      throw new DeploymentRetryable("restart lock is held");
    renameSync(config.restartLock, `${config.restartLock}.stale-${randomUUID()}`);
    try {
      claim();
    } catch (claimError) {
      if ((claimError as NodeJS.ErrnoException).code === "EEXIST")
        throw new DeploymentRetryable("restart lock is held");
      throw claimError;
    }
  }
  return () => {
    const holder = JSON.parse(readFileSync(join(config.restartLock, "owner.json"), "utf8")) as ProcessIdentity;
    if (!sameProcess(own, holder)) throw new DeploymentHeld("restart lock ownership changed");
    renameSync(config.restartLock, `${config.restartLock}.released-${randomUUID()}`);
  };
}
