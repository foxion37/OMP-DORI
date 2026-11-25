import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HeadlessObservation } from "../src/runtime/headless.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { readMonitorSet } from "../src/update/deployment-monitors.ts";
import { procChildren, procCmdline, procStat } from "../src/update/proc.ts";
import type { DeploymentConfig, MonitorSpec, RuntimeHealth } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";

const fakeHost = resolve(import.meta.dir, "fixtures/headless-rpc.ts");

/**
 * The fake native OMP. It keeps one session file per native agent so lead and duty prove distinct sessions, and a
 * `--resume=<file>` launch reopens that file. `prelude` runs inside each lead process before its host starts.
 */
export function writeFakeOmp(omp: string, sessions: string, nativeVersion: string, prelude: string): void {
  writeFileSync(
    omp,
    `#!${process.execPath}
// Release preparation inspects the private native executable's version.
if (process.argv.includes("--version")) { console.log(${JSON.stringify(nativeVersion)}); process.exit(0); }
const name = (process.env.CATALY_HARNESS_ROLE ?? "agent") + "-" + process.pid;
const resumed = process.argv.find((arg) => arg.startsWith("--resume="));
process.env.CATALY_TEST_SESSION = resumed ? resumed.slice("--resume=".length) : ${JSON.stringify(sessions)} + "/" + name + ".jsonl";
process.env.CATALY_TEST_TRACE = ${JSON.stringify(sessions)} + "/" + name + ".trace.jsonl";
process.env.CATALY_TEST_BACKGROUND_DONE = ${JSON.stringify(sessions)} + "/" + name + ".background-done";
if (process.env.CATALY_HARNESS_ROLE === "lead") {
${prelude}
}
await import(${JSON.stringify(fakeHost)});
`,
    { mode: 0o700 },
  );
}

/**
 * The default intake monitor: a lead child that refreshes the managed intake heartbeat until its lead exits. It is
 * unreferenced so the lead exits on RPC EOF like real OMP. Returns the lead prelude and the session's desired manifest.
 */
export function intakeMonitor(root: string, config: DeploymentConfig, cwd: string) {
  const script = join(root, "intake-monitor.ts");
  const heartbeat = join(config.stateDir, "activity", "intake.heartbeat");
  writeFileSync(
    script,
    `import { renameSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const parent = process.ppid;
const beat = () => {
  writeFileSync(path + "." + process.pid, String(Date.now()), { mode: 0o600 });
  renameSync(path + "." + process.pid, path);
};
beat();
setInterval(() => (process.ppid === parent ? beat() : process.exit(0)), 200);
`,
  );
  const argv = [process.execPath, script, heartbeat];
  return {
    prelude: `Bun.spawn(${JSON.stringify(argv)}, { stdio: ["ignore", "ignore", "inherit"] }).unref();`,
    manifest: (sessionId: string) => ({
      version: 1,
      sessionId,
      monitors: [{ name: "intake", argv, filter: ".*", cwd }],
      intake: { monitor: "intake", path: heartbeat, maxAgeMs: 90_000 },
    }),
  };
}

export const desiredPath = (config: DeploymentConfig, sessionId: string): string =>
  join(config.stateDir, "monitors", `${encodeURIComponent(sessionId)}.json`);

/** The desired monitors the lead session's manifest names, each bound to the lead child running exactly its argv. */
function runningMonitors(config: DeploymentConfig, lead: { readonly sessionId: string; readonly pid: number }) {
  let specs: readonly MonitorSpec[];
  try {
    specs = readMonitorSet(desiredPath(config, lead.sessionId), lead.sessionId).monitors;
  } catch {
    // No (or a once-only) desired set: the lead runs no managed monitors.
    return [];
  }
  const children = procChildren(lead.pid, true).map((pid) => ({ pid, argv: procCmdline(pid).split("\0") }));
  return specs.flatMap((spec) => {
    const child = children.find(({ argv }) => JSON.stringify(argv.filter(Boolean)) === JSON.stringify(spec.argv));
    return child ? [{ ...spec, pid: child.pid, startTicks: procStat(child.pid).startTicks }] : [];
  });
}

/**
 * Stands in for the lead's extension: while running, writes the runtime health receipt the real extension writes for
 * every live lead, with the desired monitors it actually runs. `manifest` names a session's desired monitors when the
 * fixture owns them. Returns the writer's stop function.
 */
export function leadHealthWriter(options: {
  readonly config: DeploymentConfig;
  readonly binding: () => { readonly ref: SessionRef } | undefined;
  readonly lead: () => Promise<(HeadlessObservation & { readonly pid: number }) | undefined>;
  readonly healthy: (source: string) => boolean;
  readonly manifest?: (sessionId: string) => object;
  readonly onLead?: (lead: { readonly sessionId: string; readonly pid: number }) => void;
  /** A lead loaded from such a source writes the previous main's health shape (`presetLoaded`). */
  readonly previousMain?: (source: string) => boolean;
}): () => Promise<void> {
  const { config } = options;
  let writing = true;
  const writer = (async () => {
    while (writing) {
      try {
        const binding = options.binding();
        const seen = await options.lead();
        if (seen?.sessionId) {
          const desired = desiredPath(config, seen.sessionId);
          if (options.manifest && !lstatSync(desired, { throwIfNoEntry: false }))
            saveDeploymentJson(desired, options.manifest(seen.sessionId));
          options.onLead?.({ sessionId: seen.sessionId, pid: seen.pid });
        }
        const source = realpathSync(config.liveSource);
        if (binding && seen?.sessionId && options.healthy(source)) {
          const health: RuntimeHealth = {
            version: 1,
            paneId: binding.ref.id,
            pid: seen.pid,
            sessionId: seen.sessionId,
            role: "cataly",
            configLoaded: true,
            startedAt: seen.startedAt,
            updatedAt: new Date().toISOString(),
            source,
            extensionHash: digest(readFileSync(join(source, "extension/index.ts"))),
            monitors: runningMonitors(config, { sessionId: seen.sessionId, pid: seen.pid }),
          };
          const { configLoaded, ...shared } = health;
          const written = options.previousMain?.(source) ? { ...shared, presetLoaded: configLoaded } : health;
          saveDeploymentJson(join(config.stateDir, "runtime", `${encodeURIComponent(binding.ref.id)}.json`), written);
        }
      } catch {
        // The harness is between incarnations; the next pass observes it again.
      }
      await Bun.sleep(100);
    }
  })();
  return async () => {
    writing = false;
    await writer;
  };
}
