import { lstatSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realDirectory } from "./files.ts";
import { claimNativePrune, nativeCacheRoot } from "./native-cache-lease.ts";
import { exclusiveBytes, type NativeCacheEntry, receiptHolds, reportNativeCache } from "./native-cache.ts";
import { cachePending, deleteQuarantined, type Doomed, QUARANTINE } from "./native-cache-quarantine.ts";
import { protections } from "./native-cache-refs.ts";
import { stageHolds } from "./native-cache-stage.ts";
import { type UseHoldOptions, useHolds } from "./native-cache-uses.ts";
import { processCwds, processStart } from "./process-cwd.ts";
import { type ProcessFiles, processFiles } from "./process-files.ts";

export type NativeCacheRemoval = {
  readonly directory: string;
  readonly identity: string;
  readonly bytes: number;
  readonly why: string;
};
type Quarantined = {
  readonly directory: string;
  readonly identity: string;
  readonly bytes: number;
  readonly since: string;
  readonly removableAfter: string;
};
export type NativeCachePrune = {
  readonly removed: readonly NativeCacheRemoval[];
  /** Unused identities moved aside (`.pruning`); only an explicit `--delete-quarantined` may remove them after grace. */
  readonly quarantined: readonly Quarantined[];
  readonly kept: readonly NativeCacheEntry[];
  /** Each `--trust-process PID@START` and whether it still named that process at the last look. */
  readonly trusted: readonly { readonly process: string; readonly trusted: boolean }[];
  /** With `--trust-root-cwd`: how many privileged processes with an unreadable working directory were not held. */
  readonly rootCwdTrusted: number;
};
export type NativeCachePruneOptions = {
  readonly readCwds?: typeof processCwds;
  readonly files?: () => ProcessFiles | null;
  readonly table?: () => string;
  /** `PID@START` of processes whose unreadable working directory the user vouches for, as the report printed them. */
  readonly trust?: readonly string[];
  /** Count privileged processes whose working directory cannot be read as outside the cache (their arguments count). */
  readonly trustRootCwd?: boolean;
  /** How long an identity stays quarantined, unused, before a prune may remove it (`--grace MINUTES`). */
  readonly graceMs?: number;
  /**
   * `--delete-quarantined`: remove quarantined copies unused through the grace period. Without it no identity is
   * removed: an older writer that takes no lease cannot be proven absent, so removal is the user's decision.
   */
  readonly deleteQuarantined?: boolean;
  readonly now?: number;
};

export const GRACE_MS = 10 * 60_000;
const AGAIN = "quarantined copy kept: its live name exists again; remove it by hand once nothing uses it";

/**
 * Quarantine native cache identities nothing uses, holding the prune lock throughout. No identity is removed unless
 * the user asks (`deleteQuarantined`): an older writer's absence cannot be proven. Dead unused stages may be removed.
 *
 * A prune removes preparations nothing can still finish and puts intact pre-check interruptions back into quarantine.
 * Committed removal remainders stay terminal. One look judges live identities and quarantined copies under both names.
 * An unused live identity is recorded, then moved aside (`.pruning`), so no launcher runs it half removed.
 * A quarantined copy that is used goes back. Explicit removal checks all names afresh (see `deleteQuarantined`).
 */
export function pruneNativeCache(
  home: string,
  sources: readonly string[],
  roots: readonly string[],
  options: NativeCachePruneOptions = {},
): NativeCachePrune {
  const cache = nativeCacheRoot(home);
  const tokens = new Map<string, string>();
  for (const token of options.trust ?? []) {
    const match = /^([1-9]\d*)@(\d+)$/.exec(token);
    if (!match) throw new Error(`--trust-process takes PID@START as the report prints it, not ${token}`);
    tokens.set(match[1]!, match[2]!);
  }
  // A trusted pid counts only while it is still the process the user named; a reused pid is not trusted.
  const trusted = (pid: string) => tokens.has(pid) && processStart(pid) === tokens.get(pid);
  const read = options.readCwds ?? processCwds;
  const readCwds: typeof processCwds = (pids, platform) => {
    const found = read(pids, platform);
    return found && { cwds: found.cwds, unreadable: found.unreadable.filter((pid) => !trusted(pid)) };
  };
  const privileged = new Set<string>();
  // Processes' files are read once for this prune's one look (on macOS each read is a full lsof run); the check before
  // a removal asked for reads them again.
  const readFiles = options.files ?? processFiles;
  let snapshot: ProcessFiles | null | undefined;
  const uses: UseHoldOptions = {
    readCwds,
    trusted,
    privileged,
    trustRootCwd: options.trustRootCwd === true,
    files: () => {
      if (snapshot === undefined) snapshot = readFiles();
      return snapshot;
    },
    ...(options.table ? { table: options.table } : {}),
  };
  const graceMs = options.graceMs ?? GRACE_MS;
  const now = options.now ?? Date.now();
  const result = {
    removed: [] as NativeCacheRemoval[],
    quarantined: [] as Quarantined[],
    kept: [] as NativeCacheEntry[],
  };
  const report = () => ({
    ...result,
    trusted: [...tokens].map(([pid, start]) => ({ process: `${pid}@${start}`, trusted: trusted(pid) })),
    rootCwdTrusted: options.trustRootCwd ? privileged.size : 0,
  });
  if (!lstatSync(cache, { throwIfNoEntry: false })) return report();
  const release = claimNativePrune(home);
  try {
    const records = join(cache, QUARANTINE);
    realDirectory(records, true);
    const waiting: { identity: string; directory: string; since: string }[] = [];
    const committed: { identity: string; directory: string }[] = [];
    for (const { directory, identity, state, since } of cachePending(home)) {
      if (state === "stage") {
        // A stage is removed at once, so its check reads processes' files afresh rather than the look's snapshot.
        const held = stageHolds(directory, readCwds, { ...uses, files: readFiles });
        const entry = { directory, identity, bytes: exclusiveBytes(directory) };
        if (held.length) result.kept.push({ ...entry, protectedBy: held });
        else {
          rmSync(directory, { recursive: true, force: true });
          result.removed.push({ ...entry, why: "a preparation whose owner ended and that nothing uses" });
        }
      } else if (state === "quarantined") {
        const live = directory.slice(0, directory.lastIndexOf("."));
        // A copy an interrupted removal left is quarantined again: its last check never finished.
        if (!directory.endsWith(".pruning")) renameSync(directory, `${live}.pruning`);
        // A copy without a record (moved aside by an older run) starts its grace period now.
        const start = since ?? new Date(now).toISOString();
        if (!since) writeFileSync(join(records, identity), `${start}\n`, { mode: 0o600 });
        waiting.push({ identity, directory: live, since: start });
      } else if (state === "removing") {
        committed.push({ identity, directory });
        if (!options.deleteQuarantined)
          result.kept.push({
            directory,
            identity,
            bytes: exclusiveBytes(directory),
            protectedBy: ["committed removal; --delete-quarantined is required to continue"],
          });
      }
    }
    // A record whose copy is gone (put back by hand, or a run that failed before moving it) records nothing.
    for (const identity of readdirSync(records))
      if (
        !waiting.some((entry) => entry.identity === identity) &&
        !committed.some((entry) => entry.identity === identity)
      )
        rmSync(join(records, identity), { force: true });
    const entries = reportNativeCache(home, sources, roots, readCwds, { ...uses, sweep: true });
    const keys = waiting.flatMap(({ identity }) => [identity, `${identity}.pruning`]);
    const refs = keys.length ? protections(cache, keys, sources, roots, readCwds) : new Map<string, string[]>();
    const held = keys.length ? useHolds(cache, keys, uses) : new Map<string, string[]>();
    const doomed: Doomed[] = [];
    for (const { identity, directory, since } of waiting) {
      const copy = `${directory}.pruning`;
      const bytes = exclusiveBytes(copy);
      const reasons = new Set([
        ...[identity, `${identity}.pruning`].flatMap((key) => [...(refs.get(key) ?? []), ...(held.get(key) ?? [])]),
        ...receiptHolds(copy, identity, directory),
      ]);
      if (lstatSync(directory, { throwIfNoEntry: false }))
        result.kept.push({ directory: copy, identity, bytes, protectedBy: [...reasons, AGAIN] });
      else if (reasons.size) {
        renameSync(copy, directory);
        rmSync(join(records, identity), { force: true });
        result.kept.push({ directory, identity, bytes, protectedBy: [...reasons, "put back from quarantine"] });
      } else if (!options.deleteQuarantined || now - Date.parse(since) < graceMs) {
        const removableAfter = new Date(Date.parse(since) + graceMs).toISOString();
        result.quarantined.push({ directory, identity, bytes, since, removableAfter });
      } else doomed.push({ identity, directory, bytes, since });
    }
    if (options.deleteQuarantined && (doomed.length || committed.length))
      deleteQuarantined(cache, doomed, sources, roots, readCwds, { ...uses, files: readFiles }, result, committed);
    for (const entry of entries) {
      if (entry.protectedBy.length) result.kept.push(entry);
      else if (waiting.some(({ identity }) => identity === entry.identity))
        result.kept.push({ ...entry, protectedBy: ["a quarantined copy of it is kept (see its .pruning entry)"] });
      else if (committed.some(({ identity }) => identity === entry.identity))
        result.kept.push({ ...entry, protectedBy: ["live identity kept apart from a committed removal remainder"] });
      else {
        const since = new Date(now).toISOString();
        writeFileSync(join(records, entry.identity), `${since}\n`, { mode: 0o600 });
        renameSync(entry.directory, `${entry.directory}.pruning`);
        const removableAfter = new Date(now + graceMs).toISOString();
        result.quarantined.push({
          directory: entry.directory,
          identity: entry.identity,
          bytes: entry.bytes,
          since,
          removableAfter,
        });
      }
    }
    return report();
  } finally {
    release();
  }
}
