import { lstatSync } from "node:fs";
import { parseArgs } from "node:util";
import { acquireBundle } from "./bundle.ts";
import { acquireConsumerLock, consumerPaths, initialize, pointer, realDirectory } from "./files.ts";
import { installBundle, preflightInstallation, rollbackRelease } from "./install.ts";
import { prerequisites } from "./provision.ts";
import { hasConsumerState, loadInstalled, recoverInstalled, verifyRelease } from "./state.ts";
import type { ReleaseManifest } from "./types.ts";

const USAGE = `dori update <check|install|status|rollback> [--version vX.Y.Z] [--from DIST]
  check       verify an available public release without activating it
  install     verify and install a fixed release; no messenger, watcher, model or service is started
  status      print verified installed and retained previous release identities
  rollback    verify and restore the retained previous release (--version may assert its tag)
Default check/install selects the latest stable GitHub release. Explicit tags also allow previews.
--from reads local release assets; first installation may still fetch the exact public omp-ulw pin.
Activation holds while Dori is live. Stop Dori yourself before installing or rolling back.`;

const identity = (manifest: ReleaseManifest) => ({
  tag: manifest.tag,
  commit: manifest.commit,
  sourceHash: manifest.source.hash,
  prerelease: manifest.prerelease,
});

export async function runConsumerUpdate(argv: string[]): Promise<number> {
  let releaseLock: (() => void) | undefined;
  try {
    const args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { version: { type: "string" }, from: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
    if (args.values.help || args.positionals.length === 0) {
      console.log(USAGE);
      return 0;
    }
    const command = args.positionals[0];
    if (args.positionals.length !== 1 || !["check", "install", "status", "rollback"].includes(command ?? ""))
      throw new Error(USAGE);
    if (args.values.version !== undefined && !/^v\d+\.\d+\.\d+$/.test(args.values.version))
      throw new Error("--version must be an exact vX.Y.Z tag");
    if (args.values.from !== undefined && !args.values.from.trim()) throw new Error("--from requires a directory");
    if (
      (command === "status" && (args.values.from || args.values.version)) ||
      (command === "rollback" && args.values.from)
    )
      throw new Error("--from applies to check/install; status takes no selection");
    const paths = consumerPaths();
    realDirectory(paths.dori);
    realDirectory(paths.root);
    if (command === "check") {
      const bundle = await acquireBundle({
        ...(args.values.version ? { version: args.values.version } : {}),
        ...(args.values.from ? { from: args.values.from } : {}),
      });
      const state = loadInstalled(paths);
      console.log(
        JSON.stringify(
          {
            available: bundle.manifest.tag,
            commit: bundle.manifest.commit,
            sourceHash: bundle.manifest.source.hash,
            prerelease: bundle.manifest.prerelease,
            installed: state?.current.tag ?? null,
            change: state?.current.source.hash !== bundle.manifest.source.hash,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    if (command === "status" && !hasConsumerState(paths)) {
      if (pointer(paths.live) !== undefined) throw new Error(`Unmanaged source pointer: ${paths.live}`);
      console.log(JSON.stringify({ installed: false }));
      return 0;
    }
    if (command === "install" || command === "rollback") prerequisites();
    // An unowned source directory/link is held before creating release metadata or downloading assets.
    if (!hasConsumerState(paths) && lstatSync(paths.live, { throwIfNoEntry: false }))
      throw new Error(`Unmanaged source: ${paths.live}; preserve it and move it aside before installing`);
    initialize(paths);
    releaseLock = acquireConsumerLock(paths);
    const before = recoverInstalled(paths);
    if (command === "status") {
      if (before) verifyRelease(paths, before.current);
      if (before?.previous) verifyRelease(paths, before.previous);
      console.log(
        JSON.stringify(
          {
            installed: before ? identity(before.current) : null,
            previous: before?.previous ? identity(before.previous) : null,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    preflightInstallation(paths);
    const after =
      command === "rollback"
        ? await rollbackRelease(paths, before, args.values.version)
        : await installBundle(
            paths,
            await acquireBundle({
              ...(args.values.version ? { version: args.values.version } : {}),
              ...(args.values.from ? { from: args.values.from } : {}),
            }),
            before,
          );
    console.log(
      JSON.stringify(
        {
          installed: after.current.tag,
          commit: after.current.commit,
          sourceHash: after.current.source.hash,
          previous: after.previous?.tag ?? null,
          cli: `${paths.dori}/bin/dori`,
          config: paths.config,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(`OMP-Dori release held: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    releaseLock?.();
  }
}

if (import.meta.main) process.exit(await runConsumerUpdate(process.argv.slice(2)));
