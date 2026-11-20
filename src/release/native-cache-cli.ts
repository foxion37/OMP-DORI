import { join, resolve } from "node:path";
import type { ConsumerPaths } from "./files.ts";
import { reportNativeCache } from "./native-cache.ts";
import { pruneNativeCache } from "./native-cache-prune.ts";
import { cachePending } from "./native-cache-quarantine.ts";

type CacheOptions = {
  readonly reference?: readonly string[] | undefined;
  readonly prune?: boolean | undefined;
  readonly "trust-process"?: readonly string[] | undefined;
  readonly "trust-root-cwd"?: boolean | undefined;
  readonly grace?: string | undefined;
  readonly "delete-quarantined"?: boolean | undefined;
};

/** A process of this user a prune would hold on, printed as `PID@START` so `--trust-process` can name it. */
const UNREADABLE = /^unreadable (?:working directory|open files) of process (\d+@\d+) /;

/**
 * `dori update cache`: the report by default, which removes nothing and lists the processes `--trust-process` could
 * name (`trustable`), the privileged ones `--trust-root-cwd` lets pass as a whole (`privileged`) and what waits
 * (`pending`: quarantined copies, interrupted work). `--prune` quarantines or restores; only an explicit
 * `--delete-quarantined` also removes eligible copies. Both scan default, selected, loaded and configured homes and
 * every `--reference` root.
 */
export function runCacheCommand(paths: ConsumerPaths, options: CacheOptions, installedHome?: string): number {
  const trust = options["trust-process"];
  const trustRootCwd = options["trust-root-cwd"] === true;
  const deleteQuarantined = options["delete-quarantined"] === true;
  if ((trust || trustRootCwd || options.grace !== undefined || deleteQuarantined) && !options.prune)
    throw new Error(
      "--trust-process, --trust-root-cwd, --grace and --delete-quarantined apply to cache --prune; the report changes nothing",
    );
  if (options.grace !== undefined && !/^\d+$/.test(options.grace)) throw new Error("--grace takes whole minutes");
  const sources = [resolve(import.meta.dir, "../..")];
  const roots = [
    ...new Set(
      [
        join(paths.home, ".dori"),
        join(paths.home, ".omp-dori"),
        paths.dori,
        installedHome,
        process.env["DORI_HOME"],
        process.env["OMP_DORI_HOME"],
        ...(options.reference ?? []),
      ]
        .filter((path): path is string => Boolean(path))
        .map((path) => resolve(path)),
    ),
  ];
  if (options.prune) {
    const pruned = pruneNativeCache(paths.home, sources, roots, {
      ...(trust ? { trust } : {}),
      ...(options.grace !== undefined ? { graceMs: Number(options.grace) * 60_000 } : {}),
      trustRootCwd,
      deleteQuarantined,
    });
    console.log(JSON.stringify(pruned, null, 2));
    return 0;
  }
  const privileged = new Set<string>();
  const entries = reportNativeCache(paths.home, sources, roots, undefined, { privileged });
  const trustable = new Set(
    entries.flatMap((entry) => entry.protectedBy.flatMap((reason) => UNREADABLE.exec(reason)?.[1] ?? [])),
  );
  const pending = cachePending(paths.home);
  console.log(
    JSON.stringify(
      { removes: "nothing", entries, pending, trustable: [...trustable], privileged: [...privileged] },
      null,
      2,
    ),
  );
  return 0;
}
