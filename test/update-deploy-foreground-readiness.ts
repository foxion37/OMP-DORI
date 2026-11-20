import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { procStat } from "../src/update/proc.ts";

class FixtureDeadline extends Error {}
const MONITOR_REAP_FAILURE = 70;

export async function withinFixturePhase<T>(work: Promise<T>, ms: number, phase: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new FixtureDeadline(`${phase} timed out after ${ms}ms`)), ms);
  try {
    return await Promise.race([work, promise]);
  } finally {
    clearTimeout(timer);
  }
}

function observeForegroundControl(input: Readable) {
  const controller = new AbortController();
  const { promise: closed, resolve } = Promise.withResolvers<Error | undefined>();
  const onClose = (error?: Error) => {
    controller.abort(error ?? new Error("control pipe closed before ready line"));
    resolve(error);
  };
  input.once("end", onClose);
  input.once("close", onClose);
  input.once("error", onClose);
  input.resume();
  return { closed, signal: controller.signal };
}

type Monitor = Bun.Subprocess<"pipe", "pipe" | "ignore", "ignore">;

async function waitForForegroundMonitor(child: Bun.Subprocess<"pipe", "pipe", "ignore">, signal: AbortSignal) {
  const reader = child.stdout.getReader();
  const { promise: interrupted, reject } = Promise.withResolvers<never>();
  const interrupt = () => reject(signal.reason);
  signal.addEventListener("abort", interrupt, { once: true });
  const readLine = async () => {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let text = "";
    while (!text.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stdout EOF before ready line");
      text += decoder.decode(value, { stream: true });
    }
    if (text.split("\n", 1)[0] !== "ready") throw new Error("invalid ready line");
  };
  try {
    signal.throwIfAborted();
    await Promise.race([readLine(), interrupted]);
    signal.throwIfAborted();
  } catch (error) {
    const cause = signal.aborted ? signal.reason : error;
    throw new Error(`monitor ${child.pid} readiness: ${cause}`, { cause });
  } finally {
    signal.removeEventListener("abort", interrupt);
    reader.releaseLock();
  }
}

function liveMonitor(child: Monitor): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function isDirectChild(pid: number): boolean {
  try {
    const stat = procStat(pid);
    return stat.ppid === process.pid && !stat.zombie;
  } catch {
    return false; // No current ownership observation, no signal.
  }
}

async function stopForegroundMonitors(children: readonly Monitor[], transient: Monitor | undefined) {
  if (transient && liveMonitor(transient) && isDirectChild(transient.pid)) transient.kill("SIGTERM");
  for (const child of children) if (liveMonitor(child)) child.stdin.end();
  const reaped = Promise.all(children.map((child) => child.exited));
  try {
    await withinFixturePhase(reaped, 1_500, "foreground monitor EOF teardown");
  } catch (error) {
    if (!(error instanceof FixtureDeadline)) throw error;
    const active = children.filter(liveMonitor);
    // Only original handles independently observed as our live, direct children may be signaled.
    for (const child of active) if (liveMonitor(child) && isDirectChild(child.pid)) child.kill("SIGKILL");
    await withinFixturePhase(reaped, 1_000, `foreground monitor reap (${active.map((child) => child.pid).join(", ")})`);
  }
}

function foregroundActorSource(options: {
  readonly root: string;
  readonly signalPath: string;
  readonly commands: readonly (readonly string[])[];
  readonly stoppable?: boolean | undefined;
  readonly transient?: boolean | undefined;
}) {
  const { root, signalPath, commands, stoppable, transient } = options;
  return `#!${process.execPath}
import { createReadStream, appendFileSync } from "node:fs";
import { foregroundActor } from ${JSON.stringify(import.meta.url)};
const input = createReadStream("", { fd: 3 });
const { closed, signal: control } = foregroundActor.observeControl(input);
appendFileSync(${JSON.stringify(join(root, "starts"))}, String(process.pid) + "\\n");
const children = [];
let transient;
let stopping;
function stopChildren() {
  return stopping ??= foregroundActor.stopMonitors(children, transient).catch(error => {
    console.error(String(error));
    process.exit(${MONITOR_REAP_FAILURE});
  });
}
try {
  for (const argv of ${JSON.stringify(commands)}) children.push(Bun.spawn(argv, {
    cwd: ${JSON.stringify(root)}, stdin: "pipe", stdout: "pipe", stderr: "ignore",
  }));
  for (const child of children) await foregroundActor.waitForMonitor(child, control);
  control.throwIfAborted();
  if (${transient === true}) {
    transient = Bun.spawn(["/bin/sleep", "60"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    children.push(transient);
  }
} catch (error) {
  console.log(JSON.stringify({ error: String(error) }));
  try { await stopChildren(); } finally { input.destroy(); }
  throw error;
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, async () => { appendFileSync(${JSON.stringify(signalPath)}, signal); ${stoppable ? "await stopChildren(); process.exit(0);" : ""} });
console.log(JSON.stringify({ pid: process.pid, monitors: children.map(child => child.pid) }));
try {
  const error = await closed;
  if (error) throw error;
} finally {
  await stopChildren();
}
`;
}

function spawnForegroundActor(phase: "prior" | "current", spawn: () => ChildProcess) {
  const failure = (reason: unknown) =>
    new Error(`foreground fixture ${phase} actor readiness: ${reason}`, { cause: reason });
  let child: ChildProcess;
  try {
    child = spawn();
  } catch (error) {
    throw failure(error);
  }
  const exited = once(child, "exit").then(
    () => null,
    (error: unknown) => new Error(`process launch failed: ${error}`),
  );
  const readiness = new AbortController();
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const control = child.stdio[3] as Writable | null;
      if (control && !control.destroyed && !control.writableEnded) control.end();
      if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      const teardown = `foreground fixture ${phase} actor teardown (PID ${child.pid})`;
      try {
        await withinFixturePhase(exited, 4_000, teardown);
        if (child.exitCode === MONITOR_REAP_FAILURE) throw new Error(`${teardown}: monitor reaping failed`);
      } catch (error) {
        // Do not escalate from the parent: a shell may have already handed off its foreground job.
        readiness.abort(error);
        throw error;
      }
    })());
  const waitForReady = async () => {
    if (!child.stdout) throw failure("missing stdout pipe");
    const lines = createInterface({ input: child.stdout });
    const options = { signal: readiness.signal };
    try {
      const eof = once(lines, "close", options).then(() => Promise.reject(new Error("stdout EOF before ready line")));
      // A normal exit can precede delivery of the actor's last stdout line.
      const spawnFailure = exited.then((error) => (error ? Promise.reject(error) : eof));
      const [line] = await Promise.race([once(lines, "line", options), eof, spawnFailure]);
      const observed = JSON.parse(String(line)) as { pid: number; monitors: number[] } | { error: string };
      if ("error" in observed) throw new Error(observed.error);
      return observed;
    } catch (error) {
      throw failure(readiness.signal.reason ?? error);
    } finally {
      readiness.abort();
      lines.close();
    }
  };
  return { child, stop, waitForReady };
}

export const foregroundActor = {
  spawn: spawnForegroundActor,
  source: foregroundActorSource,
  observeControl: observeForegroundControl,
  waitForMonitor: waitForForegroundMonitor,
  stopMonitors: stopForegroundMonitors,
};

export function silentForegroundActor() {
  const root = mkdtempSync(join(tmpdir(), "dori-silent-foreground-"));
  const marker = join(root, "monitor.pid");
  const script = join(root, "actor");
  const { promise: started, resolve } = Promise.withResolvers<void>();
  const watcher = watch(root, () => {
    if (existsSync(marker)) resolve();
  });
  try {
    const commands = [
      [
        "/bin/bash",
        "-c",
        'printf "%s\\n" "$$" > "$1.tmp" && mv "$1.tmp" "$1" && IFS= read -r line',
        "silent foreground monitor",
        marker,
      ],
    ];
    writeFileSync(script, foregroundActor.source({ root, commands, signalPath: join(root, "signals") }));
    const actor = foregroundActor.spawn("current", () =>
      spawn(process.execPath, [script], { cwd: root, stdio: ["pipe", "pipe", "ignore", "pipe"] }),
    );
    return {
      ...actor,
      async monitorPid() {
        await withinFixturePhase(started, 2_500, "silent foreground monitor start");
        return Number(readFileSync(marker, "utf8").trim());
      },
      async dispose() {
        watcher.close();
        try {
          await actor.stop();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
