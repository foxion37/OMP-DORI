import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError } from "../../skills/dori-mode/scripts/src/config.ts";
import { platform } from "../platform/index.ts";
import { captureSetupFile } from "../setup-files.ts";
import { acquireBundle } from "./bundle.ts";
import { runAutomaticCommand } from "./automatic-cli.ts";
import { acquireConsumerLock, consumerPaths, initialize, pointer, realDirectory } from "./files.ts";
import { installBundle, preflightInstallation, rollbackRelease } from "./install.ts";
import { runCacheCommand } from "./native-cache-cli.ts";
import { prerequisites } from "./provision.ts";
import { previewConsumerSetup, setupRuntime } from "./setup.ts";
import { supportsReleaseProfile } from "./manifest.ts";
import { consumerReleaseHome } from "./runtime.ts";
import { hasConsumerState, loadInstalled, recoverInstalled, verifyRelease } from "./state.ts";
import type { ReleaseManifest } from "./types.ts";

const USAGE = `dori update <check|install|status|rollback|cache> [--version vX.Y.Z] [--from DIST] [--home PATH] [--runtime hc|herdr]
  auto <status|enable|disable>  manage daily stable-release checks at consumer OMP launch
  check       verify an available public release without activating it
  install     verify and install a fixed release; no messenger, watcher, model or service is started
              --preview verifies a configuration plan in disposable storage, without installation or dependency changes
  status      print verified installed and retained previous release identities
  rollback    verify and restore the retained previous release (--version may assert its tag)
  cache       report native identities, users and sizes (read-only); --reference DIR adds scan roots (repeatable)
              --prune quarantines unused identities and restores used ones; --delete-quarantined deletes after --grace MINUTES (default 10)
              Deletion rechecks usage but can race unleased writers or later publication.
              --trust-process PID@START (repeatable) excludes listed unreadable PIDs; --trust-root-cwd treats unreadable root cwd as outside cache
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
  if (argv[0] === "auto") return runAutomaticCommand(argv.slice(1));
  let releaseLock: (() => void) | undefined;
  try {
    const args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        version: { type: "string" },
        from: { type: "string" },
        home: { type: "string" },
        runtime: { type: "string" },
        preview: { type: "boolean" },
        prune: { type: "boolean" },
        reference: { type: "string", multiple: true },
        "trust-process": { type: "string", multiple: true },
        "trust-root-cwd": { type: "boolean" },
        grace: { type: "string" },
        "delete-quarantined": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (args.values.help || args.positionals.length === 0) {
      console.log(USAGE);
      return 0;
    }
    const command = args.positionals[0];
    if (args.positionals.length !== 1 || !["check", "install", "status", "rollback", "cache"].includes(command ?? ""))
      throw new Error(USAGE);
    if (args.values.preview && command !== "install") throw new Error("--preview applies only to install");
    if (args.values.version !== undefined && !/^v\d+\.\d+\.\d+$/.test(args.values.version))
      throw new Error("--version must be an exact vX.Y.Z tag");
    if (args.values.from !== undefined && !args.values.from.trim()) throw new Error("--from requires a directory");
    if (args.values.runtime !== undefined && !["hc", "herdr"].includes(args.values.runtime))
      throw new Error("--runtime must be hc or herdr");
    if (
      (command === "status" && (args.values.from || args.values.version)) ||
      (command === "rollback" && args.values.from)
    )
      throw new Error("--from applies to check/install; status takes no selection");
    if (
      (command === "cache" &&
        (args.values.from !== undefined || args.values.version !== undefined || args.values.runtime !== undefined)) ||
      (command !== "cache" &&
        (args.values.reference ||
          args.values.prune ||
          args.values["trust-process"] ||
          args.values["trust-root-cwd"] ||
          args.values.grace !== undefined ||
          args.values["delete-quarantined"]))
    )
      throw new Error(
        "cache takes only --home, --reference, --prune, --trust-process, --trust-root-cwd, --grace and --delete-quarantined",
      );
    const installedHome = consumerReleaseHome(realpathSync(resolve(import.meta.dir, "../..")));
    const selected = args.values.home ?? installedHome ?? process.env["DORI_HOME"] ?? join(homedir(), ".dori");
    if (!isAbsolute(selected)) throw new Error("--home / DORI_HOME must be an absolute installation home");
    const paths = consumerPaths(homedir(), selected);
    for (const dir of [paths.dori, paths.root]) realDirectory(dir);
    if (command === "cache") return runCacheCommand(paths, args.values, installedHome);
    if (!hasConsumerState(paths) && lstatSync(join(paths.dori, ".omp-dori"), { throwIfNoEntry: false }))
      throw new Error("Unmanaged source installation; use a separate release home or the documented stopped migration");
    const config = command === "status" ? undefined : captureSetupFile(paths.config);
    let runtime = args.values.runtime;
    if (command === "status") prerequisites(runtime ?? platform.defaultRuntime(), false);
    if (command !== "status") {
      runtime = setupRuntime(config!, runtime);
      prerequisites(runtime, !args.values.preview && (command === "install" || command === "rollback"));
    }
    const compatible = (manifest: ReleaseManifest, metadata?: Uint8Array): void => {
      if (
        paths.dori !== join(paths.home, ".dori") &&
        !manifest.source.files.some((file) => file.path === "release-capabilities.json")
      )
        throw new Error("Legacy releases do not support isolated homes; keep them in the primary ~/.dori home");
      if (
        !supportsReleaseProfile(
          manifest,
          { platform: platform.os, arch: process.arch, runtime: runtime ?? "" },
          metadata,
        )
      )
        throw new Error(`Release ${manifest.tag} does not support ${platform.os}/${process.arch}/${runtime}`);
    };
    if (command === "check") {
      const bundle = await acquireBundle({
        ...(args.values.version ? { version: args.values.version } : {}),
        ...(args.values.from ? { from: args.values.from } : {}),
      });
      compatible(bundle.manifest, bundle.files.find((file) => file.path === "release-capabilities.json")?.bytes);
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
    // An unowned source directory/link is held before creating release metadata or downloading assets.
    if (!hasConsumerState(paths) && lstatSync(paths.live, { throwIfNoEntry: false }))
      throw new Error(`Unmanaged source: ${paths.live}; preserve it and move it aside before installing`);
    if (command !== "status" && !args.values.preview) preflightInstallation(paths);
    const bundle =
      command === "install"
        ? await acquireBundle({
            ...(args.values.version ? { version: args.values.version } : {}),
            ...(args.values.from ? { from: args.values.from } : {}),
          })
        : undefined;
    if (bundle)
      compatible(bundle.manifest, bundle.files.find((file) => file.path === "release-capabilities.json")?.bytes);
    if (args.values.preview && bundle) {
      const release = identity(bundle.manifest);
      const configuration = previewConsumerSetup(paths, bundle, config!);
      console.log(JSON.stringify({ preview: true, release, configuration }, null, 2));
      return 0;
    }
    if (command === "rollback") {
      const previous = loadInstalled(paths)?.previous;
      if (previous) {
        const source = verifyRelease(paths, previous);
        compatible(
          previous,
          previous.source.files.some((file) => file.path === "release-capabilities.json")
            ? readFileSync(join(source, "release-capabilities.json"))
            : undefined,
        );
      }
    }
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
    if (!bundle && before?.previous) {
      const source = verifyRelease(paths, before.previous);
      compatible(
        before.previous,
        before.previous.source.files.some((file) => file.path === "release-capabilities.json")
          ? readFileSync(join(source, "release-capabilities.json"))
          : undefined,
      );
    }
    if ((bundle?.manifest ?? before?.previous)?.requirements.omp === "18.18.8")
      prerequisites(runtime!, true, true, paths);
    const after = bundle
      ? await installBundle(paths, bundle, before, { config: config! })
      : await rollbackRelease(paths, before, args.values.version, config);
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
    const reason =
      error instanceof SyntaxError || error instanceof ConfigError
        ? "Invalid configuration or release metadata; inspect the selected files"
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`OMP-Dori release held: ${reason}`);
    return 2;
  } finally {
    releaseLock?.();
  }
}

if (import.meta.main) process.exit(await runConsumerUpdate(process.argv.slice(2)));
