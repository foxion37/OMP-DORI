import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { Readable } from "node:stream";
import { type OutputProcess, recordCommandOutput } from "./command-output.ts";
import { UpdateDetectionUnavailable, UpdateInterrupted } from "./config.ts";
import type { CommandReceipt } from "./types.ts";

type ProcessRow = { pid: number; parent: number; group: number; state: string; started: string };
type StopReason = "deadline" | "abort" | "child-exit" | "output-failure";
export type DetectionReceipt = CommandReceipt & {
  detector?: {
    group: number;
    groupVerified: boolean;
    reason?: StopReason;
    outputComplete: boolean;
    stopped: boolean;
    escaped: number[];
    proofError?: string;
  };
};

// These ps fields and detached setsid semantics are available on both Linux and macOS.
function processTable(): ProcessRow[] {
  const result = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    encoding: "utf8",
    timeout: 1_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("detector process readback failed");
  return result.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match) throw new Error("detector process readback was incomplete");
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        state: match[4]!,
        started: match[5]!,
      };
    });
}

/** Only this invocation's detached POSIX group is signalled. Missing EOF or escaped ownership stays held. */
export async function runDetectorProcess(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  receipt: DetectionReceipt,
  started: (pid: number) => void,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new UpdateInterrupted("detector interrupted before launch");
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new UpdateInterrupted("detector process-group proof requires Linux or macOS");
  }
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const { promise: exited, resolve: exit } = Promise.withResolvers<number>();
  child.once("exit", (code, killed) => exit(code ?? (killed ? 128 + constants.signals[killed] : 1)));
  const launched = Promise.withResolvers<void>();
  child.once("spawn", launched.resolve);
  child.once("error", launched.reject);
  await launched.promise;
  const group = child.pid;
  if (group === undefined) throw new UpdateInterrupted("detector process identity is unavailable");
  const known = new Map<number, string>();
  const escaped = new Set<number>();
  let groupVerified = false;
  let leaderStarted: string | undefined;
  let signalAttempted = false;
  let proofError: string | undefined;
  let reason: StopReason | undefined;
  let outputComplete = false;
  let observing = true;
  const observe = (): ProcessRow[] => {
    try {
      const table = processTable();
      const root = table.find((row) => row.pid === group);
      if (root && leaderStarted !== undefined && root.started !== leaderStarted) {
        groupVerified = false;
        proofError ??= "detector group leader identity changed";
      } else if (root?.group === group && child.exitCode === null && child.signalCode === null) {
        leaderStarted = root.started;
        groupVerified = true;
      }
      const owned = new Set([group]);
      for (const row of table) {
        if (known.get(row.pid) === row.started || (groupVerified && row.group === group)) owned.add(row.pid);
      }
      let previous = -1;
      while (owned.size !== previous) {
        previous = owned.size;
        for (const row of table) if (owned.has(row.parent)) owned.add(row.pid);
      }
      for (const row of table) {
        if (!owned.has(row.pid)) continue;
        known.set(row.pid, row.started);
        if (!row.state.startsWith("Z") && row.group !== group) escaped.add(row.pid);
      }
      return table.filter((row) => !row.state.startsWith("Z") && owned.has(row.pid));
    } catch (error) {
      proofError ??= error instanceof Error ? error.message : String(error);
      return [];
    }
  };
  const stop = (cause: StopReason): void => {
    const members = observe().filter((row) => row.group === group);
    if (cause !== "child-exit" || members.length > 0) reason ??= cause;
    if (members.length === 0) return;
    if (!groupVerified) {
      proofError ??= "detector process-group ownership was not verified";
      return;
    }
    if (signalAttempted) return;
    signalAttempted = true;
    try {
      process.kill(-group, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") proofError ??= "detector group termination failed";
    }
  };
  observe();
  const abort = (): void => stop("abort");
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => stop("deadline"), timeoutMs);
  const monitor = setInterval(observe, 100);
  void exited.then(() => {
    if (observing) stop("child-exit");
  });
  let outputError: unknown;
  try {
    started(group);
    const proc: OutputProcess = {
      stdout: Readable.toWeb(child.stdout),
      stderr: Readable.toWeb(child.stderr),
      exited,
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: (killSignal) => {
        child.kill(killSignal);
      },
    };
    // The owned group deadline runs first; the recorder retains its existing bounded drain and direct-child backstop.
    await recordCommandOutput(proc, receipt, [], timeoutMs + 1_000, signal, () => {
      outputComplete = true;
    });
  } catch (error) {
    outputError = error;
    stop("output-failure");
  } finally {
    observing = false;
    clearTimeout(deadline);
    clearInterval(monitor);
    signal?.removeEventListener("abort", abort);
  }
  let survivors = observe();
  const until = Date.now() + 1_000;
  while (survivors.some((row) => row.group === group) && Date.now() < until) {
    await Bun.sleep(20);
    survivors = observe();
  }
  const stopped = outputComplete && proofError === undefined && escaped.size === 0 && survivors.length === 0;
  if (signal?.aborted) reason = "abort";
  receipt.detector = {
    group,
    groupVerified,
    outputComplete,
    stopped,
    escaped: [...escaped],
    ...(reason === undefined ? {} : { reason }),
    ...(proofError === undefined ? {} : { proofError }),
  };
  if (signal?.aborted) {
    throw new UpdateInterrupted(
      stopped && outputComplete
        ? "detector explicitly aborted; owned group stopped; attempt remains held"
        : "detector explicitly aborted; descendants may still be running; inspect detector receipt",
    );
  }
  if (!stopped || !outputComplete || (reason !== undefined && !groupVerified)) {
    throw new UpdateInterrupted(
      "detector termination is unproven; descendants may still be running; inspect detector receipt",
    );
  }
  if (reason !== undefined || outputError !== undefined) {
    throw new UpdateDetectionUnavailable("detector attempt stopped with complete output and no live owned descendants");
  }
}
