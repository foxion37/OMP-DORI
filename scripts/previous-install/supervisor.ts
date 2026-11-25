// One-way bridge from previous installations (see cli.ts). Only the installers run it; the product never imports it.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { procCmdline } from "../../src/update/proc.ts";
import { entry, inside } from "./paths.ts";

type Log = (line: string) => void;

/** A running `scripts/update-supervisor.ts` and the options it was started with. */
type Supervisor = { readonly pid: number; readonly config: string; readonly controller: string; readonly mode: string };

/** The previous main's controller: a source tree that still binds the removed omp-ulw overlay. */
const PREVIOUS_CONTROLLER = "omp-ulw.overlay.lock";

/** This user's update supervisors whose update config lies in `home`, read from their exact argument vectors. */
function supervisors(home: string): Supervisor[] {
  const ps = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,uid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) throw new Error("the process table could not be read");
  const uid = process.getuid?.();
  const found: Supervisor[] = [];
  for (const line of ps.stdout.toString().split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (!row || !row[3]!.includes("update-supervisor.ts") || (uid !== undefined && Number(row[2]) !== uid)) continue;
    let argv: string[];
    try {
      argv = procCmdline(Number(row[1])).split("\0").slice(0, -1);
    } catch {
      continue;
    }
    const script = argv.findIndex((arg) => arg.endsWith("/scripts/update-supervisor.ts"));
    if (script < 0) continue;
    const options = new Map<string, string>();
    for (let i = script + 1; i + 1 < argv.length; i += 2) options.set(argv[i]!, argv[i + 1]!);
    const config = options.get("--config");
    const controller = options.get("--controller");
    if (!config?.startsWith("/") || !controller?.startsWith("/") || !inside(config, home)) continue;
    found.push({ pid: Number(row[1]), config, controller, mode: options.get("--mode") ?? "upstream" });
  }
  return found;
}

const previousController = (controller: string): boolean => {
  try {
    return entry(join(realpathSync(controller), PREVIOUS_CONTROLLER))?.isFile() === true;
  } catch {
    return false;
  }
};

/** The environment an update supervisor gives its controller: no credentials, no telemetry. */
function controllerEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CATALY_TELEMETRY: "0", DO_NOT_TRACK: "1" };
  for (const key of Object.keys(env))
    if (
      /^CATALY_.*(?:TOKEN|PASSWORD)$/.test(key) ||
      ["SUDO_UID", "SUDO_GID", "SUDO_USER", "GH_TOKEN", "GITHUB_TOKEN"].includes(key)
    )
      delete env[key];
  return env;
}

/**
 * Hand each managed deployment whose supervisor still runs the previous main's controller to this version. That
 * controller holds every deployment, because it cannot prepare the removed overlay. For a source-mode supervisor this
 * version's controller in `source` runs the supervisor's own step once, `update source apply --when idle`, whose
 * deployment switches the controller link; the supervisor then restarts on it. An upstream-mode supervisor's step
 * starts model work, so it is left to its next deployment.
 */
export function handOverDeployments(source: string, home: string, log: Log): void {
  const seen = new Set<string>();
  for (const supervisor of supervisors(home)) {
    if (seen.has(supervisor.config) || !previousController(supervisor.controller)) continue;
    seen.add(supervisor.config);
    if (supervisor.mode !== "source") {
      log(
        `The managed deployment of ${supervisor.config} (supervisor ${supervisor.pid}) still runs the previous controller; the move completes when its next deployment runs this version`,
      );
      continue;
    }
    log(`Handing the managed deployment of ${supervisor.config} to this version's controller in ${source}`);
    const apply = Bun.spawnSync(
      [
        process.execPath,
        join(source, "skills/cataly-mode/scripts/src/cli.ts"),
        "update",
        "source",
        "apply",
        "--when",
        "idle",
        "--config",
        supervisor.config,
      ],
      { cwd: source, env: controllerEnv(), stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    );
    if (apply.exitCode === 0 && !previousController(supervisor.controller))
      log(`Moved the managed deployment of ${supervisor.config} to this version's controller`);
    else
      log(
        `The managed deployment of ${supervisor.config} stays on the previous controller for now (exit ${apply.exitCode}); the next install retries`,
      );
  }
}
