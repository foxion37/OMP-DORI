import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { platform, procfsOn } from "../platform/index.ts";
import { liveTasks, processIsKernelThread } from "./process-cwd.ts";

/** What `processFiles` reads: paths by pid, and live pids whose files could not be read (they may use anything). */
export type ProcessFiles = { readonly files: Map<string, string[]>; readonly unread: readonly string[] };

const ended = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");

/** The executable, open descriptors and mapped files of one Linux thread group, read through threads that still run. */
function groupFiles(pid: string, tasks: readonly string[]): string[] {
  // A leader that exited (a zombie) shows no executable or mappings; any running thread shows the group's.
  const base = tasks.includes(pid) ? `/proc/${pid}` : `/proc/${pid}/task/${tasks[0]}`;
  const paths = [readlinkSync(`${base}/exe`)];
  for (const line of readFileSync(`${base}/maps`, "utf8").split("\n")) {
    const mapped = /^\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+(\/.*)$/.exec(line)?.[1];
    if (mapped) paths.push(mapped);
  }
  // Threads usually share one descriptor table, but one made without it has its own.
  for (const tid of tasks)
    for (const fd of readdirSync(`/proc/${pid}/task/${tid}/fd`)) {
      try {
        paths.push(readlinkSync(`/proc/${pid}/task/${tid}/fd/${fd}`));
      } catch (error) {
        if (!ended(error)) throw error;
      }
    }
  return paths;
}

/**
 * Paths this user's running processes use besides their working directory, by pid: on Linux the executable they run,
 * every open descriptor (a directory included) and every mapped file, read through any thread that still runs (a
 * leader that exited leaves its threads running); elsewhere what `lsof` lists for this user. `unread` holds live pids
 * whose files could not be read, whatever their working directory shows. Null when nothing at all could be read.
 * Linux callers inspecting a known process set may provide its PIDs instead of enumerating all of `/proc`.
 */
export function processFiles(os = platform.os, linuxPids?: readonly string[]): ProcessFiles | null {
  const files = new Map<string, string[]>();
  const unread: string[] = [];
  const uid = process.getuid?.();
  if (!procfsOn(os)) {
    let lsof: ReturnType<typeof Bun.spawnSync>;
    try {
      lsof = Bun.spawnSync(["lsof", "-n", ...(uid === undefined ? [] : ["-u", String(uid)]), "-F", "pn"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      });
    } catch {
      return null;
    }
    // A failed or cut-short run may have printed only part of the table.
    if (lsof.exitCode !== 0 || lsof.exitedDueToTimeout || lsof.signalCode || !lsof.stdout?.length) return null;
    let pid = "";
    for (const line of lsof.stdout.toString().split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      else if (line.startsWith("n/") && pid) files.set(pid, [...(files.get(pid) ?? []), line.slice(1)]);
    }
    return { files, unread };
  }
  for (const pid of linuxPids ?? readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (uid !== undefined && statSync(`/proc/${pid}`).uid !== uid) continue;
    } catch {
      continue;
    }
    if (processIsKernelThread(pid) === true) continue;
    const tasks = liveTasks(pid);
    if (!tasks) continue;
    try {
      files.set(pid, groupFiles(pid, tasks));
    } catch (error) {
      // Gone meanwhile uses nothing; still running but unreadable (not dumpable) may use anything.
      if (!ended(error) || liveTasks(pid)) unread.push(pid);
    }
  }
  return files.size ? { files, unread } : null;
}

/** Whether a path a process uses is `directory` itself or lies inside it (a deleted one keeps its old path). */
export const usesDirectory = (path: string, directory: string): boolean => {
  const plain = path.endsWith(" (deleted)") ? path.slice(0, -" (deleted)".length) : path;
  return plain === directory || plain.startsWith(`${directory}/`);
};
