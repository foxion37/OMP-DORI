import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeploymentConfig, ProcessIdentity, ToolchainReceipt } from "./deployment-types.ts";

export class DeploymentHeld extends Error {}
export class DeploymentBusy extends DeploymentHeld {}
export class DeploymentRetryable extends DeploymentHeld {}
export const processIdentity = (pid: number): ProcessIdentity | undefined => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/.test(startTicks) || fields[0] === "Z") return undefined;
    const image = statSync(`/proc/${pid}/exe`, { bigint: true });
    return {
      pid,
      startTicks,
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      executable: readlinkSync(`/proc/${pid}/exe`),
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
    for (let at = pid; at > 1 && !seen.has(at); ) {
      if (at === root) return true;
      seen.add(at);
      const stat = readFileSync(`/proc/${at}/stat`, "utf8");
      at = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    }
  } catch {
    return false;
  }
  return false;
}

/** No caller environment, tokens, sudo context or global Bun policy enters a prepared release/native actor. */
export function actorEnv(config: DeploymentConfig, toolchain?: ToolchainReceipt): Record<string, string> {
  return {
    HOME: config.home,
    PATH: [
      dirname(toolchain?.bun ?? config.bun),
      dirname(toolchain?.omp ?? config.omp),
      dirname(config.herdr),
      join(config.doriHome, "bin"),
      join(config.home, ".bun", "bin"),
      "/usr/bin",
      "/bin",
    ].join(":"),
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    DORI_HOME: config.doriHome,
    DORI_CONFIG: config.doriConfig,
    DORI_STATE_DIR: config.stateDir,
    HERDR_PANE_ID: config.pane,
    HERDR_WORKSPACE_ID: config.pane.slice(0, config.pane.indexOf(":")),
    ...(config.herdrSession ? { DORI_HERDR_SESSION: config.herdrSession } : {}),
    DORI_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  };
}

export async function command(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DeploymentHeld("deployment interrupted before command");
  if (!argv[0]) throw new Error("deployment command is empty");
  const proc = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
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
    if (code !== 0)
      throw new DeploymentRetryable("deployment command failed; operator data and credentials were not captured");
    return Buffer.concat(chunks).toString().trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/** Recover only a provably dead holder. Unknown ownership remains held, regardless of age. */
export function acquireRestartLock(config: DeploymentConfig): () => void {
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
