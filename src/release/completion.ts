import { ConfigError } from "../../skills/cataly-mode/scripts/src/config.ts";
import { type ConsumerPaths, pointer } from "./files.ts";
import { type InstalledState, loadInstalled, releaseId, releasePath } from "./state.ts";

export type ReleaseAttempt = {
  readonly paths: ConsumerPaths;
  readonly before: InstalledState | undefined;
  readonly source: string | undefined;
  readonly command: string;
};

/** Classify the installed result, not the last fallible maintenance operation. Never recover or mutate here. */
export function releaseFailure(error: unknown, attempt?: ReleaseAttempt): number {
  const reason =
    error instanceof SyntaxError || error instanceof ConfigError
      ? "Invalid configuration or release metadata; inspect the selected files"
      : error instanceof Error
        ? error.message
        : String(error);
  if (attempt) {
    const { paths, before, source, command } = attempt;
    try {
      const current = loadInstalled(paths);
      const selected = pointer(paths.live);
      if (selected !== (current ? releasePath(paths, current.current) : undefined))
        throw new Error("Source pointer and installed receipt disagree");
      if (current && (selected !== source || releaseId(current.current) !== (before && releaseId(before.current)))) {
        console.log(
          JSON.stringify({
            installed: current.current.tag,
            commit: current.current.commit,
            sourceHash: current.current.source.hash,
            previous: current.previous?.tag ?? null,
            status: "committed-maintenance-pending",
          }),
        );
        console.error(`Cataly ${command} committed; maintenance pending: ${reason}`);
        return 3;
      }
    } catch (inspection) {
      console.error(
        `Cataly release outcome unresolved: ${reason}; ${inspection instanceof Error ? inspection.message : String(inspection)}; run status with this controller`,
      );
      return 4;
    }
  }
  console.error(`Cataly release held: ${reason}`);
  return 2;
}
