// One-way bridge from previous installations (see cli.ts). Only the installers run it; the product never imports it.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { processCwds } from "../../src/release/process-cwd.ts";
import { processFiles, usesDirectory } from "../../src/release/process-files.ts";
import { processExists } from "../../src/update/proc.ts";
import { isObject } from "./config.ts";
import { entry, readText } from "./paths.ts";

/** Lock and receipt files of an earlier home that name the process holding them. */
const HOME_RECORDS = [
  "harness.lock",
  "controller.lock",
  "duty/lock",
  "loop/lock",
  "loop/runner.lock",
  "releases/active.json",
  "releases/consumer.lock/owner.json",
  "releases/consumer-launch.lock/owner.json",
];
/** Words only an omp-dori process carries on its command line. */
const OMP_DORI_WORDS = /--dori-role\b|\/skills\/dori-mode\/|(?:^|[\s/])(?:omp-dori|dori-harness)(?=\s|$)/;

/** The PIDs a lock, health or endpoint record names, at its top level or as its runtime. */
function recordedPids(path: string): number[] {
  try {
    const value: unknown = JSON.parse(readText(path) ?? "");
    if (!isObject(value)) return [];
    const runtime = value["runtime"];
    return [value["pid"], isObject(runtime) ? runtime["pid"] : undefined].filter(
      (pid): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0,
    );
  } catch {
    return [];
  }
}

/** Every record a home and its state directories keep for a running harness, lead, lane, monitor or lock holder. */
function records(home: string, stateDirs: readonly string[]): string[] {
  const files = HOME_RECORDS.map((name) => join(home, name));
  const list = (dir: string) => (entry(dir)?.isDirectory() ? readdirSync(dir) : []);
  for (const state of stateDirs) {
    for (const kind of ["runtime", "monitors"])
      for (const name of list(join(state, kind))) if (name.endsWith(".json")) files.push(join(state, kind, name));
    // A headless host that stopped leaves its receipt; one still serving has only its endpoint.
    for (const id of list(join(state, "headless")))
      if (!entry(join(state, "headless", id, "stopped.json"))) files.push(join(state, "headless", id, "endpoint.json"));
  }
  return files.filter((file) => entry(file)?.isFile());
}

const mentions = (args: string, path: string): boolean =>
  ` ${args} `.includes(` ${path}/`) || ` ${args} `.includes(` ${path} `) || args.includes(`=${path}/`);

/**
 * Whether an omp-dori process may belong to `homes`: its environment selects one of them or this HOME. A process
 * whose environment cannot be read (no /proc) may belong to any of them.
 */
function belongs(pid: string, homes: readonly string[]): boolean {
  let environ: string;
  try {
    environ = readFileSync(`/proc/${pid}/environ`, "latin1");
  } catch {
    return true;
  }
  const selected = new Set([...homes, process.env["HOME"] ?? ""]);
  return environ
    .split("\0")
    .some((pair) => /^(?:HOME|DORI_HOME|OMP_DORI_HOME)=/.test(pair) && selected.has(pair.slice(pair.indexOf("=") + 1)));
}

/**
 * Why `directories` are still in use, or undefined: a live PID in their records, or another process of this user that
 * names them in its command line, works in them or holds a file in them. With `ompDori`, an omp-dori process of this
 * HOME or of these directories counts too, whatever it names.
 */
export function inUse(
  directories: readonly string[],
  options: { readonly stateDirs?: readonly string[]; readonly ompDori?: boolean } = {},
): string | undefined {
  const paths = [...new Set(directories.flatMap((dir) => [dir, ...(entry(dir) ? [realpathSync(dir)] : [])]))];
  for (const dir of directories)
    for (const file of records(dir, options.stateDirs ?? [join(dir, "state")]))
      for (const pid of recordedPids(file))
        if (pid !== process.pid && processExists(pid)) return `process ${pid} recorded in ${file} is running`;
  const ps = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,uid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) return "the process table could not be read";
  const uid = process.getuid?.();
  const rows = ps.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const row = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
      return row && row[1] !== String(process.pid) && (uid === undefined || Number(row[2]) === uid)
        ? [{ pid: row[1]!, args: row[3]!.trim() }]
        : [];
    });
  for (const { pid, args } of rows) {
    if (
      paths.some((path) => mentions(args, path)) ||
      (options.ompDori && OMP_DORI_WORDS.test(args) && belongs(pid, paths))
    )
      return `process ${pid} (${args.slice(0, 120)}) is running`;
  }
  const cwds = processCwds(rows.map(({ pid }) => pid));
  for (const [pid, cwd] of cwds?.cwds ?? [])
    if (paths.some((path) => usesDirectory(cwd, path))) return `process ${pid} works in ${cwd}`;
  const files = processFiles();
  if (!files) return "no process's open files could be read";
  for (const [pid, used] of files.files)
    if (pid !== String(process.pid))
      for (const file of used)
        if (paths.some((path) => usesDirectory(file, path))) return `process ${pid} uses ${file}`;
  return undefined;
}
