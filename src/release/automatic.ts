import { realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { platform } from "../platform/index.ts";
import { captureSetupFile, SetupConflict, type SetupSnapshot } from "../setup-files.ts";
import { underProcess } from "../update/deployment-process.ts";
import { acquireBundle, type VerifiedBundle } from "./bundle.ts";
import {
  automaticConfig,
  automaticOverrides,
  preflightAutomaticInstallation,
  verifyAutomaticInstallation,
} from "./automatic-policy.ts";
import { readAutomaticState, saveAutomaticState, type AutomaticState } from "./automatic-state.ts";
import { acquireConsumerLock, ConsumerLockBusy, type ConsumerPaths, consumerPaths, readJson } from "./files.ts";
import { installBundle } from "./install.ts";
import { assertNoConsumerLaunches, registerConsumerLaunch, waitLaunchGate } from "./launch-leases.ts";
import { supportsReleaseProfile, validateReleaseManifest } from "./manifest.ts";
import { prerequisites } from "./provision.ts";
import { consumerReleaseHome } from "./runtime.ts";
import { hasConsumerState, loadInstalled, recoverInstalled, releasePath, verifyRelease } from "./state.ts";

const DAY = 24 * 60 * 60 * 1000;
type AutomaticOptions = {
  readonly now?: number;
  readonly source?: string;
  readonly paused?: boolean;
  readonly launchOwner?: number;
  readonly followCurrent?: boolean;
  readonly acquire?: (signal: AbortSignal) => Promise<VerifiedBundle>;
  readonly checkTools?: typeof prerequisites;
};

function newer(candidate: string, current: string): boolean {
  const left = candidate.split(".").map(BigInt);
  const right = current.split(".").map(BigInt);
  for (let at = 0; at < 3; at++) {
    if (left[at] !== right[at]) return left[at]! > right[at]!;
  }
  return false;
}

/** Whole-release updates reuse the manual installer; no mutable dependency or alternative trust channel exists. */
export async function automaticUpdate(paths: ConsumerPaths, options: AutomaticOptions = {}): Promise<string> {
  const installed = loadInstalled(paths);
  if (!installed) throw new Error("Automatic updates require an installed consumer release");
  const source = await verifyAutomaticInstallation(paths, installed);
  let state = readAutomaticState(paths);
  if (options.source && options.source !== source) {
    if (options.followCurrent) return source;
    const retained = validateReleaseManifest(readJson(join(paths.manifests, `${basename(options.source)}.json`)));
    if (releasePath(paths, retained) !== options.source)
      throw new Error("Automatic launch source is not a retained consumer release");
    return verifyRelease(paths, retained);
  }
  const now = options.now ?? Date.now();
  if (!state.enabled || options.paused || now < state.nextCheck) return source;
  let unlock: () => void;
  try {
    unlock = acquireConsumerLock(paths);
  } catch (error) {
    // The caller's live launch lease blocks the other updater's final activation. No wait on its downloads.
    if (error instanceof ConsumerLockBusy) return source;
    throw error;
  }
  try {
    const observed = recoverInstalled(paths, options.launchOwner);
    if (!observed) throw new Error("Consumer installation disappeared before automatic update");
    if (releasePath(paths, observed.current) !== source) return verifyAutomaticInstallation(paths, observed);
    state = readAutomaticState(paths);
    if (!state.enabled || now < state.nextCheck) return source;
    const attempted: AutomaticState = { version: 1, enabled: true, lastAttempt: now, nextCheck: now + DAY };
    const finish = (outcome: NonNullable<AutomaticState["outcome"]>, detail?: string, available?: string): void => {
      saveAutomaticState(paths, {
        ...attempted,
        outcome,
        ...(detail ? { detail: detail.slice(0, 500) } : {}),
        ...(available ? { available } : {}),
      });
    };
    let snapshot: SetupSnapshot;
    try {
      snapshot = captureSetupFile(paths.config);
    } catch (error) {
      if (!(error instanceof SetupConflict)) throw error;
      const runnable = await verifyAutomaticInstallation(paths, observed);
      finish("held", error.message);
      return runnable;
    }
    const config = automaticConfig(paths);
    if (automaticOverrides(paths, config)) {
      finish("held", "Explicit native or ULW override; use the manual release updater");
      return source;
    }
    // Record attempts, not only successes: offline launches and failed preparation cannot hammer the channel.
    saveAutomaticState(paths, attempted);
    try {
      const gate = await waitLaunchGate(paths);
      try {
        assertNoConsumerLaunches(paths, options.launchOwner);
      } finally {
        gate();
      }
      preflightAutomaticInstallation(paths);
      const runtime = config["runtime"];
      if (typeof runtime !== "string") throw new Error("Consumer config must explicitly select its runtime");
      (options.checkTools ?? prerequisites)(runtime, true, installed.current.requirements.omp === "18.18.8", paths);
      const candidate = await (options.acquire ?? ((signal) => acquireBundle({}, signal)))(AbortSignal.timeout(15_000));
      const manifest = candidate.manifest;
      if (manifest.prerelease || !newer(manifest.releaseVersion, installed.current.releaseVersion)) {
        if (manifest.tag === installed.current.tag && JSON.stringify(manifest) !== JSON.stringify(installed.current))
          throw new Error("Published tag differs from the retained installed manifest");
        finish("current", undefined, manifest.tag);
        return source;
      }
      const capabilities = candidate.files.find((file) => file.path === "release-capabilities.json")?.bytes;
      if (
        (paths.dori !== join(paths.home, ".dori") && !capabilities) ||
        !supportsReleaseProfile(manifest, { platform: platform.os, arch: process.arch, runtime }, capabilities)
      )
        throw new Error("Available release does not support this installation profile");
      // Do not remove the bound launcher by automatically selecting the legacy native protocol.
      if (installed.current.requirements.omp === "18.20.0" && manifest.requirements.omp !== "18.20.0")
        throw new Error("Automatic updates cannot downgrade the bound native protocol");
      preflightAutomaticInstallation(paths);
      const after = await installBundle(paths, candidate, installed, {
        config: snapshot,
        beforeActivate: () => preflightAutomaticInstallation(paths),
        ...(options.launchOwner === undefined ? {} : { launchOwner: options.launchOwner }),
      });
      finish("installed", undefined, manifest.tag);
      return verifyRelease(paths, after.current);
    } catch (error) {
      // Optional network/preparation failures do not make a valid installation unusable. Local drift still does.
      const current = recoverInstalled(paths, options.launchOwner);
      if (!current) throw new Error("Consumer installation disappeared during automatic update");
      const runnable = await verifyAutomaticInstallation(paths, current);
      const detail = error instanceof Error ? error.message : String(error);
      finish(error instanceof SetupConflict || /holds|held|Live/.test(detail) ? "held" : "failed", detail);
      return runnable;
    }
  } finally {
    unlock();
  }
}

export async function automaticLaunch(
  sourceRoot: string,
  home: string,
  argv: readonly string[] = [],
  launcherPid?: number,
): Promise<string> {
  const source = realpathSync(sourceRoot);
  const dori = consumerReleaseHome(source);
  if (!dori) return source; // Ordinary source checkouts are not migrated or networked.
  const paths = consumerPaths(home, dori);
  if (!hasConsumerState(paths) || !loadInstalled(paths)) throw new Error("Consumer launch has no installed receipt");
  if (launcherPid !== undefined) {
    if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0 || !underProcess(process.pid, launcherPid))
      throw new Error("Consumer launch owner is not this helper's ancestor");
    const gate = await waitLaunchGate(paths);
    try {
      registerConsumerLaunch(paths, launcherPid);
    } finally {
      gate();
    }
  }
  const pinned = !!process.env["DORI_MANAGED_STARTUP"] || argv.includes("--no-extensions");
  return automaticUpdate(paths, {
    source,
    followCurrent: !pinned,
    ...(launcherPid === undefined ? {} : { launchOwner: launcherPid }),
    paused:
      process.env["DORI_AUTO_UPDATE"] === "0" ||
      !!process.env["DORI_MANAGED_STARTUP"] ||
      argv.some((arg) => ["--version", "--help", "-v", "-h", "--no-extensions"].includes(arg)),
  });
}

if (import.meta.main) {
  const [source, home, rawPid, ...argv] = process.argv.slice(2);
  try {
    if (!source || !home || !rawPid || !/^\d+$/.test(rawPid))
      throw new Error("Automatic launch requires source, home and launcher PID");
    console.log(await automaticLaunch(resolve(source), resolve(home), argv, Number(rawPid)));
  } catch (error) {
    console.error(`OMP-Dori launch held: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
