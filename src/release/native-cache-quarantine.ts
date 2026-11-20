import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { platform } from "../platform/index.ts";
import { owned, realDirectory, syncDirectory } from "./files.ts";
import { nativeCacheRoot, nativeStage } from "./native-cache-lease.ts";
import { exclusiveBytes, type NativeCacheEntry, receiptHolds } from "./native-cache.ts";
import type { NativeCacheRemoval } from "./native-cache-prune.ts";
import { protections } from "./native-cache-refs.ts";
import { type UseHoldOptions, useHolds } from "./native-cache-uses.ts";
import type { processCwds } from "./process-cwd.ts";

const LEFTOVER = new RegExp(
  `^${platform.nativeCacheLabel()}-([a-f0-9]{64})\\.(pruning|deleting-[a-f0-9]{16}|removing-[a-f0-9]{16})$`,
);
export const QUARANTINE = "native-quarantine";

/**
 * What waits in the cache: restorable quarantine/pre-check copies (`quarantined`), committed removals (`removing`,
 * never restored), preparations whose owner ended (`stage`) and ones naming no owner (`older stage`).
 */
export function cachePending(home: string): { directory: string; identity: string; state: string; since?: string }[] {
  const cache = nativeCacheRoot(home);
  if (!lstatSync(cache, { throwIfNoEntry: false })) return [];
  return readdirSync(cache).flatMap((name) => {
    const directory = join(cache, name);
    const match = LEFTOVER.exec(name);
    if (match) {
      const since = quarantinedSince(cache, match[1]!);
      const state = match[2]!.startsWith("removing-") ? "removing" : "quarantined";
      return [{ directory, identity: match[1]!, state, ...(since ? { since } : {}) }];
    }
    if (!name.startsWith("native-stage-")) return [];
    const stage = nativeStage(name);
    if (!stage) return [{ directory, identity: "", state: "older stage" }];
    return stage.ended ? [{ directory, identity: stage.identity, state: "stage" }] : [];
  });
}

/** When an identity was quarantined, as its record says; undefined without a readable record. */
function quarantinedSince(cache: string, identity: string): string | undefined {
  try {
    const since = readFileSync(join(cache, QUARANTINE, identity), "utf8").trim();
    return Number.isNaN(Date.parse(since)) ? undefined : since;
  } catch {
    return undefined;
  }
}

export type Doomed = {
  readonly identity: string;
  readonly directory: string;
  readonly bytes: number;
  readonly since: string;
};

/**
 * `--delete-quarantined`: check unused copies under their live, quarantine and pre-check names, then commit removal by
 * renaming to `.removing-<nonce>` before touching contents. Committed remainders are never restored; an explicit
 * request checks all names afresh before continuing. An older writer can still publish after the last check.
 */
export function deleteQuarantined(
  cache: string,
  doomed: readonly Doomed[],
  sources: readonly string[],
  roots: readonly string[],
  readCwds: typeof processCwds,
  uses: UseHoldOptions,
  result: { removed: NativeCacheRemoval[]; kept: NativeCacheEntry[] },
  committed: readonly { readonly directory: string; readonly identity: string }[] = [],
): void {
  const nonce = randomBytes(8).toString("hex");
  const copies = [
    ...doomed.map((entry) => {
      if (entry.directory !== join(cache, `${platform.nativeCacheLabel()}-${entry.identity}`))
        throw new Error("Native removal must name a direct cache child");
      realDirectory(`${entry.directory}.pruning`);
      owned(`${entry.directory}.pruning`);
      return { ...entry, copy: `${entry.directory}.deleting-${nonce}`, committed: false };
    }),
    ...committed.map(({ directory, identity }) => {
      const match = LEFTOVER.exec(basename(directory));
      if (dirname(directory) !== cache || !match || match[1] !== identity || !match[2]!.startsWith("removing-"))
        throw new Error("Committed native removal must name a direct cache child");
      realDirectory(directory);
      owned(directory);
      return {
        identity,
        directory: directory.slice(0, directory.lastIndexOf(".")),
        copy: directory,
        bytes: exclusiveBytes(directory),
        since: undefined,
        committed: true,
      };
    }),
  ].map((entry) => {
    const suffix = entry.copy.slice(-16);
    return {
      ...entry,
      names: [
        entry.identity,
        `${entry.identity}.pruning`,
        `${entry.identity}.deleting-${suffix}`,
        `${entry.identity}.removing-${suffix}`,
      ],
    };
  });
  for (const entry of copies) if (!entry.committed) renameSync(`${entry.directory}.pruning`, entry.copy);
  const keys = copies.flatMap((entry) => entry.names);
  const refs = protections(cache, keys, sources, roots, readCwds);
  const held = useHolds(cache, keys, uses);
  for (const { identity, directory, copy, bytes, since, committed, names } of copies) {
    const reasons = new Set(names.flatMap((key) => [...(refs.get(key) ?? []), ...(held.get(key) ?? [])]));
    // A committed copy may already lack its receipt. Ownership and entry permissions still apply.
    if (committed) {
      if ((lstatSync(copy).mode & 0o011) !== 0) reasons.add("directory other users can enter");
    } else for (const reason of receiptHolds(copy, identity, directory)) reasons.add(reason);
    if (reasons.size || (!committed && lstatSync(directory, { throwIfNoEntry: false }))) {
      // Only a pre-check copy may go back; a partially removed committed copy must stay terminal.
      let back = copy;
      if (!committed) {
        back = lstatSync(directory, { throwIfNoEntry: false }) ? `${directory}.pruning` : directory;
        renameSync(copy, back);
        if (back === directory) rmSync(join(cache, QUARANTINE, identity), { force: true });
      }
      result.kept.push({
        directory: back,
        identity,
        bytes,
        protectedBy: [...reasons, committed ? "committed removal kept in place" : "kept at the check before removal"],
      });
      continue;
    }
    const terminal = committed ? copy : `${directory}.removing-${copy.slice(-16)}`;
    if (!committed) renameSync(copy, terminal);
    // Persist the irreversible state before recursive removal can fail or be interrupted partway through.
    syncDirectory(cache);
    rmSync(terminal, { recursive: true, force: true });
    if (!lstatSync(`${directory}.pruning`, { throwIfNoEntry: false }))
      rmSync(join(cache, QUARANTINE, identity), { force: true });
    result.removed.push({
      directory: committed ? copy : directory,
      identity,
      bytes,
      why: committed
        ? "finishing a committed removal; removal asked"
        : `unused through its quarantine since ${since}; removal asked`,
    });
  }
}
