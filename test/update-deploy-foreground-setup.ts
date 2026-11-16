import { afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { type PaneState, writePaneState } from "../skills/dori-mode/scripts/src/lane-state.ts";
import { processIdentity } from "../src/update/deployment-process.ts";
import { procChildren, procCmdline, procStat } from "../src/update/proc.ts";
import type { MonitorSet, RuntimeHealth, RuntimeIdentity } from "../src/update/deployment-types.ts";
import { foregroundCli } from "./update-deploy-foreground-cli.ts";
import { processName } from "./proc-name.ts";
import { deploymentConfig } from "./update-deploy-setup.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
/** Real exec-launched native group and script children; herdr supplies only their observed metadata. */
export async function foregroundFixture(
  options: {
    unknown?: boolean;
    parentShell?: boolean;
    rollback?: boolean;
    paneShell?: boolean;
    stoppable?: boolean;
    subshell?: boolean;
    transient?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "dori-foreground-"));
  const config = {
    ...deploymentConfig(root),
    omp: join(root, "omp"),
    ...(options.rollback ? { bun: process.execPath } : {}),
    monitorBootstrapFile: join(root, "bootstrap.json"),
    quiesceCheckpointFile: join(root, "quiesce.json"),
  };
  const sessionFile = join(root, "session.jsonl");
  const launchArgs = options.rollback
    ? [
        "--config",
        join(config.releaseRoot, "native-config.json"),
        `--resume=${sessionFile}`,
        "--dori-role",
        "dori",
        "--model",
        config.model,
      ]
    : [];
  const signalPath = join(root, "signals");
  const script = join(root, "known.sh");
  const dori = join(root, "dori");
  const presence = join(root, "presence.sh");
  const unknown = join(root, "unknown.sh");
  const nested = options.subshell ? "(while IFS= read -r line; do :; done) <&0 &\n" : "";
  const shell = `#!/bin/bash\ntrap 'printf signal >> ${signalPath}' TERM INT HUP\n${nested}printf 'ready\\n'\nwhile IFS= read -r line; do :; done\nwait\n`;
  writeFileSync(script, shell, { mode: 0o700 });
  writeFileSync(unknown, shell, { mode: 0o700 });
  writeFileSync(dori, `#!${process.execPath}\nconsole.log("ready"); await Bun.stdin.text();\n`, { mode: 0o700 });
  writeFileSync(presence, `#!/bin/bash\nexec ${JSON.stringify(dori)} "$@"\n`, { mode: 0o700 });
  const specs = [
    { name: "intake", argv: [script], filter: ".", cwd: root },
    { name: "dori-watch", argv: [presence], filter: ".", cwd: root },
  ];
  // Direct shebang exec names /proc/comm after the script; explicit Bash reproduces the production foreground.
  const commands = [["/bin/bash", script], [presence], ...(options.unknown ? [["/bin/bash", unknown]] : [])];
  writeFileSync(
    config.omp,
    `#!${process.execPath}
import { createReadStream, appendFileSync } from "node:fs"; import { once } from "node:events";
appendFileSync(${JSON.stringify(join(root, "starts"))}, String(process.pid) + "\\n");
const children = ${JSON.stringify(commands)}.map(argv => Bun.spawn(argv, {
  cwd: ${JSON.stringify(root)}, stdin: "pipe", stdout: "pipe", stderr: "ignore",
}));
for (const child of children) {
  const reader = child.stdout.getReader();
  const ready = new TextDecoder().decode((await reader.read()).value);
  reader.releaseLock();
  if (ready !== "ready\\n") throw new Error("child did not initialize");
} if (${options.transient === true}) children.push(Bun.spawn(["/bin/sleep", "60"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" }));
const input = createReadStream("", { fd: 3 });
async function stopChildren() { for (const child of children) { if (${options.transient === true} && child === children.at(-1) && child.exitCode === null) child.kill("SIGTERM"); child.stdin.end(); await child.exited; } }
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, async () => { appendFileSync(${JSON.stringify(signalPath)}, signal); ${options.stoppable ? "await stopChildren(); process.exit(0);" : ""} });
console.log(JSON.stringify({ pid: process.pid, monitors: children.map(child => child.pid) }));
const closed = once(input, "end");
input.resume();
await closed;
await stopChildren();
`,
    { mode: 0o700 },
  );
  const args =
    options.parentShell || options.paneShell
      ? ["--noprofile", "--norc", "-i"]
      : ["--noprofile", "--norc", "-c", 'exec "$@"', "native", process.execPath, config.omp, ...launchArgs];
  const runtimeFor = (pid: number): RuntimeIdentity => ({
    ...processIdentity(pid)!,
    role: "dori",
    pane: config.pane,
    sessionId: config.sessionId,
    sessionFile,
    startedAt: new Date().toISOString(),
    cwd: root,
  });
  const launch = async () => {
    const requestedAt = new Date().toISOString();
    const child = spawn("/bin/bash", args, {
      cwd: root,
      detached: true,
      env: { PATH: "/usr/bin:/bin", HOME: root, HISTFILE: "/dev/null" },
      stdio: ["pipe", "pipe", "ignore", "pipe"],
    });
    const exited = once(child, "exit");
    const lines = createInterface({ input: child.stdout! });
    const ready = once(lines, "line");
    if (options.parentShell || options.paneShell)
      child.stdin!.write(
        `${options.paneShell ? "set -m\n" : ""}${[process.execPath, config.omp, ...launchArgs].map((arg) => JSON.stringify(arg)).join(" ")}\n${options.parentShell ? "exit\n" : ""}`,
      );
    const [line] = await ready;
    lines.close();
    const observed = JSON.parse(String(line)) as { pid: number; monitors: number[] };
    return { child, exited, observed, requestedAt };
  };
  const previous = options.rollback ? await launch() : undefined;
  const previousRuntime = previous ? runtimeFor(previous.observed.pid) : undefined;
  const previousMonitors = previous?.observed.monitors.slice(0, specs.length).map((pid, index) => ({
    ...processIdentity(pid)!,
    name: specs[index]!.name,
    argv: procCmdline(pid).split("\0").filter(Boolean),
  }));
  if (previous) {
    (previous.child.stdio[3] as Writable).end();
    previous.child.stdin!.end();
    await previous.exited;
  }
  const { child, exited, observed, requestedAt } = await launch();
  const runtime = runtimeFor(observed.pid);
  cleanups.push(async () => {
    (child.stdio[3] as Writable).end();
    child.stdin!.end();
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  let state: PaneState = {
    ...runtime,
    paneId: config.pane,
    updatedAt: runtime.startedAt,
    goal: { status: "none" },
    approvalPending: false,
    agentStatus: "idle",
  };
  const writeState = (changes: Partial<PaneState> = {}): void => {
    state = { ...state, ...changes };
    writePaneState(config.stateDir, state);
  };
  writeState();
  const bootstrap: MonitorSet = {
    version: 1,
    sessionId: runtime.sessionId,
    runtime,
    monitors: specs,
    intake: { path: join(root, "heartbeat"), monitor: "intake", maxAgeMs: 5_000 },
    running: specs.map(({ name }, index) => {
      const pid = observed.monitors[index]!;
      return { name, pid, identity: processIdentity(pid)! };
    }),
  };
  const writeBootstrap = (value = bootstrap): void => {
    writeFileSync(config.monitorBootstrapFile, JSON.stringify(value), { mode: 0o600 });
  };
  writeBootstrap();
  const health: RuntimeHealth = {
    version: 1,
    paneId: config.pane,
    pid: runtime.pid,
    sessionId: runtime.sessionId,
    role: "dori",
    presetLoaded: true,
    startedAt: runtime.startedAt,
    updatedAt: runtime.startedAt,
    source: root,
    extensionHash: "observed-fixture-code",
    monitors: specs.map((spec, index) => ({
      ...spec,
      pid: observed.monitors[index]!,
      startTicks: processIdentity(observed.monitors[index]!)!.startTicks,
    })),
  };
  const writeHealth = (value = health): void => {
    const path = join(config.stateDir, "runtime", `${encodeURIComponent(config.pane)}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    const desired = join(config.stateDir, "monitors", `${encodeURIComponent(config.sessionId)}.json`);
    mkdirSync(dirname(desired), { recursive: true });
    writeFileSync(desired, JSON.stringify({ ...bootstrap, runtime: undefined, running: undefined }), { mode: 0o600 });
  };
  const pids = [...(options.parentShell ? [child.pid!] : []), runtime.pid, ...observed.monitors];
  if (options.subshell) {
    pids.push(...procChildren(observed.monitors[0]!));
  }
  const front = {
    shell_pid: options.parentShell || options.paneShell ? child.pid! : process.pid,
    foreground_process_group_id: procStat(runtime.pid).pgid as number | undefined,
    foreground_processes: pids.map((pid) => ({
      pid: pid as number | undefined,
      name: processName(pid),
      argv: procCmdline(pid).split("\0").filter(Boolean),
    })),
  };
  const observe = () => {
    if (options.paneShell && !processIdentity(runtime.pid)) {
      front.foreground_process_group_id = child.pid!;
      front.foreground_processes = [
        {
          pid: child.pid!,
          name: "bash",
          argv: procCmdline(child.pid!).split("\0").filter(Boolean),
        },
      ];
    }
    return { front, status: state.agentStatus! };
  };
  const cli = foregroundCli(config, observe);
  return {
    root,
    config,
    runtime,
    previousRuntime,
    previousMonitors,
    launchRequestedAt: requestedAt,
    signalPath,
    script,
    bootstrap,
    health,
    front,
    cli,
    writeState,
    writeBootstrap,
    writeHealth,
    observe,
    sendLine: (line: string) => child.stdin!.write(`${line}\n`),
    closeNativeInput: () => (child.stdio[3] as Writable).end(),
  };
}
