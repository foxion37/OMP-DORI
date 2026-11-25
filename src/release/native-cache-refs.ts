import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { type processCwds, processStart } from "./process-cwd.ts";
import { readSourceBundle } from "./source-bundle.ts";

const CHUNK = 1024 * 1024;
/** An identity's length, so one cut by a chunk edge is whole in the next window. */
const OVERLAP = 64;
/** Directories the walk does not enter. */
const SKIP: Record<string, true> = { ".git": true, node_modules: true };

/** Walk without following links; `visit` sees every directory, every symbolic link and every regular file. */
function walk(root: string, visit: (path: string, kind: "directory" | "file" | "link" | "skipped") => void): void {
  const stack = [root];
  while (stack.length) {
    const path = stack.pop()!;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) visit(path, "link");
    else if (stat.isFile()) visit(path, "file");
    else if (stat.isDirectory()) {
      if (path !== root && Object.hasOwn(SKIP, basename(path))) {
        visit(path, "skipped");
        continue;
      }
      visit(path, "directory");
      for (const name of readdirSync(path)) stack.push(join(path, name));
    }
  }
}

/** A file of any size, read whole in overlapping windows: no name it holds goes unread. */
function readWindows(path: string, read: (text: string) => void): void {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(CHUNK);
    let carry = "";
    for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer)) {
      const text = carry + buffer.toString("latin1", 0, n);
      read(text);
      carry = text.slice(-OVERLAP);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * What uses each identity: a source under `sources`/`roots` binds it, a file of any size under `roots` (wrappers,
 * consumer state, deployment records/toolchains) names it, or a running process names it. What this scan cannot
 * confirm is reported against every identity: skipped subtrees, a source lock that cannot be read, a link that cannot
 * be read or leads to an unscanned directory, and unreadable process working directories. An unreadable process table
 * or reference file throws instead of reporting nothing as used.
 */
export function protections(
  cache: string,
  keys: readonly string[],
  sources: readonly string[],
  roots: readonly string[],
  readCwds: typeof processCwds,
): Map<string, string[]> {
  const reasons = new Map<string, string[]>();
  const add = (key: string, reason: string) => {
    const kept = reasons.get(key) ?? [];
    if (!kept.includes(reason)) reasons.set(key, [...kept, reason]);
  };
  const all = (reason: string) => {
    for (const key of keys) add(key, reason);
  };
  const names = (text: string, reason: string) => {
    for (const key of keys) if (text.includes(key)) add(key, reason);
  };
  const bind = (source: string, where: string) => {
    // No lock binds nothing; a lock that cannot be read could bind any identity.
    if (!lstatSync(join(source, "native-omp.lock"), { throwIfNoEntry: false })) return;
    try {
      add(readSourceBundle(source).identity, `source ${where}`);
    } catch {
      all(`unreadable source lock ${where}`);
    }
  };
  for (const source of sources) bind(source, source);
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const cacheReal = real(cache);
  const rootsReal = roots.map(real);
  // Whether the walk reads this real directory: it lies in a root and under no directory the walk skips.
  const walked = (directory: string): boolean =>
    rootsReal.some((dir) => {
      const rel = relative(dir, directory);
      return (
        rel === "" ||
        (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).some((part) => Object.hasOwn(SKIP, part)))
      );
    });
  // A root given as a link (a `--reference` alias) is walked at its real path, so its contents are read.
  for (const root of rootsReal)
    walk(root, (path, kind) => {
      if (kind === "skipped") {
        if (!walked(path)) all(`unscanned directory ${path}`);
        return;
      }
      if (kind === "directory") return bind(path, path);
      if (kind === "file") return readWindows(path, (text) => names(text, `reference ${path}`));
      // A link into the cache (an `omp` on PATH, a release's toolchain link) keeps its target, through link chains too.
      let target: string;
      try {
        target = readlinkSync(path);
      } catch {
        return all(`unreadable link ${path}`);
      }
      let resolved = "";
      try {
        resolved = realpathSync(path);
      } catch (error) {
        // Only a missing target makes a dangling link, which names only its own target text. A target that cannot be
        // reached (no permission, a loop) may be anything.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") all(`unresolved link ${path}`);
      }
      names(`${target}\0${resolved}`, `link ${path}`);
      // A target inside the cache is identified by its path alone.
      if (!resolved || resolved === cacheReal || resolved.startsWith(`${cacheReal}/`)) return;
      // A link to a file (a wrapper elsewhere) keeps what that file names. A link to a directory keeps the source it
      // binds, and unless the walk reads that directory itself, what is inside it is unknown: it keeps every identity.
      const stat = lstatSync(resolved, { throwIfNoEntry: false });
      if (stat?.isFile()) readWindows(resolved, (text) => names(text, `reference ${path}`));
      else if (stat?.isDirectory()) {
        bind(resolved, path);
        if (!walked(resolved)) all(`link to an unscanned directory ${path}`);
      }
    });
  const ps = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,uid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) throw new Error("Process table is unavailable; native cache use cannot be ruled out");
  const processes = ps.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const row = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
      return row ? [{ pid: row[1]!, uid: Number(row[2]), args: row[3]!.trim() }] : [];
    });
  // A process also uses an entry through its working directory. Only this user's processes can be inside an entry
  // (0700 under an owned cache; root is judged by its arguments alone), and any of them whose directory cannot be read
  // may use any identity.
  const uid = process.getuid?.();
  const read = readCwds(processes.filter((row) => row.uid === uid).map((row) => row.pid));
  if (!read) all("process working directories unavailable");
  const unreadable = new Set(read?.unreadable);
  for (const { pid, args } of processes) {
    if (unreadable.has(pid)) {
      const start = processStart(pid);
      all(`unreadable working directory of process ${start ? `${pid}@${start}` : pid} (${args})`);
    }
    names(`${args}\0${read?.cwds.get(pid) ?? ""}`, `process ${pid}`);
  }
  return reasons;
}
