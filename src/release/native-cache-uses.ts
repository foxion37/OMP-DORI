import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { platform } from "../platform/index.ts";
import { nativeStage, readLeases } from "./native-cache-lease.ts";
import { processCwds, processIsKernelThread, processStart } from "./process-cwd.ts";
import { type ProcessFiles, processFiles, usesDirectory } from "./process-files.ts";

/** Commands an update or deployment runs after its program (`<program> update install`, `<program> upstream watch`). */
const SUBCOMMAND = /^(?:install|rollback|check|stage|watch|restart|recover)$/;
/** Actions of `source-dependencies.ts` that prepare, verify or lease a native identity; its next two words are source and home. */
const SOURCE_ACTION = /^(?:native|assert-native|consumer|lease-path)$/;

/**
 * Whether a process is a Cataly writer that creates, verifies or launches identities, judged by the base names of its
 * words so absolute and relative paths (`bun scripts/source-dependencies.ts native ...`) count alike: the home it
 * names for `source-dependencies.ts`, `"env"` when its environment's HOME decides, undefined when it is no writer.
 * Writers from this release lease what they use; an older running checkout does not, so while one runs for this cache
 * no identity is confirmed unused.
 */
function writerHome(args: string): string | undefined {
  const words = args.split(/\s+/);
  const base = words.map((word) => word.slice(word.lastIndexOf("/") + 1));
  for (let at = 0; at < words.length; at++) {
    const next = base[at + 1] ?? "";
    if (base[at] === "source-dependencies.ts" && SOURCE_ACTION.test(next)) return words[at + 3] ?? "";
    if (base[at] === "install-source.sh") return "env";
    if (base[at] === "cli.ts" && /^(?:install|rollback)$/.test(next)) return "env";
    if (["cli.ts", "cataly", "cataly-harness"].includes(base[at]!) && /^(?:update|upstream)$/.test(next))
      if (SUBCOMMAND.test(base[at + 2] ?? "")) return "env";
  }
  return undefined;
}

/** `CAP_DAC_OVERRIDE` and `CAP_DAC_READ_SEARCH`: a process holding either can enter an owner-only directory. */
const ENTERS_ANY = 0b110n;

/** `pid uid args` per running process, as `ps` prints them. */
function processTable(): string {
  const ps = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,uid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) throw new Error("Process table is unavailable; native cache use cannot be ruled out");
  return ps.stdout.toString();
}

/**
 * Whether another user's process could be inside an owner-only entry: root, or (Linux) one holding a capability that
 * ignores directory permissions; never a kernel thread. Other users cannot enter (receipts keep an entry whose directory
 * lets them). A process this cannot inspect counts as able to.
 */
function entersAny(pid: string, uid: number): boolean {
  if (!platform.procfs) return uid === 0;
  try {
    const kernel = processIsKernelThread(pid);
    if (kernel === undefined) return true;
    if (kernel) return false;
    if (uid === 0) return true;
    const caps = /^CapEff:\s*([0-9a-f]+)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    return caps === undefined || (BigInt(`0x${caps}`) & ENTERS_ANY) !== 0n;
  } catch {
    return true;
  }
}

/**
 * Whether a writer works on the cache under `homes`: by the home it names (relative to its working directory), else by
 * its environment's HOME. Only a home that resolves to another existing directory rules it out.
 */
function writesHere(pid: string, args: string, named: string, homes: readonly string[]): boolean {
  if (homes.some((home) => args.includes(home))) return true;
  if (!platform.procfs && !isAbsolute(named)) return true;
  try {
    let home: string | undefined;
    if (named === "env") home = /(?:^|\0)HOME=([^\0]*)/.exec(readFileSync(`/proc/${pid}/environ`, "latin1"))?.[1];
    else if (named) home = isAbsolute(named) ? named : resolve(readlinkSync(`/proc/${pid}/cwd`), named);
    return home === undefined || homes.includes(realpathSync(home));
  } catch {
    return true;
  }
}

type ProcessRow = { readonly pid: string; readonly uid: number; readonly args: string };
const processRows = (table: string): ProcessRow[] =>
  table.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    return row ? [{ pid: row[1]!, uid: Number(row[2]), args: row[3]!.trim() }] : [];
  });

/** The running Cataly writers for the cache `cache` (see `writerHome`), as reasons that keep every identity. */
function writerReasons(cache: string, rows: readonly ProcessRow[]): string[] {
  const home = resolve(cache, "../..");
  const homes = [...new Set([home, realpathSync(home)])];
  return rows.flatMap(({ pid, args }) => {
    const named = writerHome(args);
    return named !== undefined && writesHere(pid, args, named, homes)
      ? [`Cataly cache writer process ${pid} (${args})`]
      : [];
  });
}

export type UseHoldOptions = {
  /** Under the prune lock: remove leases whose holder ended. */
  readonly sweep?: boolean;
  readonly table?: () => string;
  readonly readCwds?: typeof processCwds;
  /** `--trust-root-cwd`: privileged processes whose working directory cannot be read are not held on. */
  readonly trustRootCwd?: boolean;
  /** The reader of this user's processes' files (`processFiles`). */
  readonly files?: () => ProcessFiles | null;
  /** A pid the user vouched for (`--trust-process`): its unreadable files do not keep anything. */
  readonly trusted?: (pid: string) => boolean;
  /** Receives `PID@START (args)` of every privileged process whose working directory could not be read. */
  readonly privileged?: Set<string>;
};

/**
 * What keeps identities besides what the report reads (see `protections`, which judges this user's processes): a live
 * lease keeps its identity, and so does a process of this user that runs, maps or holds open a file in it (the entry
 * itself open as a directory included); a lease that cannot be read, a preparation of an older writer, a running Cataly
 * writer for this cache and a privileged process whose working directory cannot be read keep every identity. Keys may
 * also be quarantined names (`<identity>.pruning`), which a lease on that identity keeps too.
 */
export function useHolds(cache: string, keys: readonly string[], options: UseHoldOptions = {}): Map<string, string[]> {
  const reasons = new Map<string, string[]>();
  const add = (key: string, reason: string) => {
    const kept = reasons.get(key) ?? [];
    if (!kept.includes(reason)) reasons.set(key, [...kept, reason]);
  };
  const all = (reason: string) => {
    for (const key of keys) add(key, reason);
  };
  const leases = readLeases(cache, options.sweep === true);
  for (const reason of leases.unread) all(reason);
  for (const key of keys) for (const reason of leases.byIdentity.get(key.slice(0, 64)) ?? []) add(key, reason);
  for (const name of readdirSync(cache)) {
    if (!name.startsWith("native-stage-")) continue;
    // A stage is judged by its own name (see native-cache-stage.ts), never as an identity.
    const stage = nativeStage(name);
    // An older writer's preparation names no identity or owner; an ended one holds nothing (a prune removes it).
    if (!stage) all(`native preparation of an older writer ${join(cache, name)}`);
    else if (!stage.ended)
      for (const key of keys) if (key.startsWith(stage.identity)) add(key, `native preparation ${join(cache, name)}`);
  }
  const rows = processRows((options.table ?? processTable)());
  for (const reason of writerReasons(cache, rows)) all(reason);
  // What this user's processes run, map or hold open inside an entry, whatever their arguments and working directory
  // say. A live process whose files cannot be read may use any entry, unless the user trusted it.
  const found = (options.files ?? processFiles)();
  if (!found) all("open files of processes unavailable");
  const argsOf = new Map(rows.map((row) => [row.pid, row.args]));
  for (const pid of found?.unread ?? [])
    if (!options.trusted?.(pid))
      all(`unreadable open files of process ${pid}@${processStart(pid) ?? "?"} (${argsOf.get(pid) ?? ""})`);
  const caches = [...new Set([cache, realpathSync(cache)])];
  for (const key of keys) {
    const entries = caches.map((root) => join(root, `${platform.nativeCacheLabel()}-${key}`));
    for (const [pid, paths] of found?.files ?? [])
      if (paths.some((used) => entries.some((entry) => usesDirectory(used, entry))))
        add(key, `process ${pid} has it open, mapped or running`);
  }
  const uid = process.getuid?.();
  const privileged = rows.filter((row) => row.uid !== uid && entersAny(row.pid, row.uid));
  if (!privileged.length) return reasons;
  // This process's own directory is always readable, so no answer at all means the reader failed.
  const read = (options.readCwds ?? processCwds)([String(process.pid), ...privileged.map((row) => row.pid)]);
  if (!read) all("process working directories unavailable");
  const unread = privileged.filter((row) => read?.unreadable.includes(row.pid));
  for (const { pid } of privileged)
    for (const key of keys) if (read?.cwds.get(pid)?.includes(key)) add(key, `process ${pid}`);
  for (const { pid, args } of unread) options.privileged?.add(`${pid}@${processStart(pid) ?? "?"} (${args})`);
  if (unread.length && !options.trustRootCwd)
    all(`unreadable working directories of ${unread.length} root or privileged processes (see --trust-root-cwd)`);
  return reasons;
}
