import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { assertSetupFile, type SetupSnapshot } from "../setup-files.ts";
import { assertSourceAdmission, sameManifest, sourceManifest } from "../update/source.ts";
import {
  type ConsumerPaths,
  isPrimaryConsumer,
  owned,
  pointer,
  readJson,
  realDirectory,
  regularFile,
  replacePointer,
  saveJson,
  syncDirectory,
} from "./files.ts";
import { assertNoLiveCataly } from "./live.ts";
import { acquireLaunchGate, assertNoConsumerLaunches } from "./launch-leases.ts";
import { validateReleaseManifest } from "./manifest.ts";
import { assertLock } from "./provision.ts";
import { preflightReferences } from "./references.ts";
import type { ReleaseManifest } from "./types.ts";

export type InstalledState = {
  readonly version: 1;
  readonly current: ReleaseManifest;
  readonly previous?: ReleaseManifest;
};
type Journal = { readonly version: 1; readonly before?: InstalledState; readonly after: InstalledState };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const releaseId = (manifest: ReleaseManifest): string =>
  `${manifest.commit}-${manifest.source.hash.slice(0, 16)}`;
export const releasePath = (paths: ConsumerPaths, manifest: ReleaseManifest): string =>
  join(paths.releases, releaseId(manifest));
export const manifestPath = (paths: ConsumerPaths, manifest: ReleaseManifest): string =>
  join(paths.manifests, `${releaseId(manifest)}.json`);
const nativeTarget = (paths: ConsumerPaths, state: InstalledState | undefined): string | undefined =>
  isPrimaryConsumer(paths) && state !== undefined
    ? join(releasePath(paths, state.current), "scripts/consumer/omp")
    : undefined;

function validateState(value: unknown): InstalledState {
  if (
    !object(value) ||
    value["version"] !== 1 ||
    Object.keys(value).some((key) => !["version", "current", "previous"].includes(key))
  )
    throw new Error("Installed consumer state is invalid");
  const current = validateReleaseManifest(value["current"]);
  const previous = value["previous"] === undefined ? undefined : validateReleaseManifest(value["previous"]);
  if (previous && releaseId(previous) === releaseId(current)) throw new Error("Installed rollback identity is invalid");
  return { version: 1, current, ...(previous ? { previous } : {}) };
}

export function loadInstalled(paths: ConsumerPaths): InstalledState | undefined {
  if (!regularFile(paths.state)) return undefined;
  return validateState(readJson(paths.state));
}

export function assertInstalledPointer(paths: ConsumerPaths, state: InstalledState | undefined): void {
  const expected = state ? releasePath(paths, state.current) : undefined;
  if (pointer(paths.live) !== expected)
    throw new Error(
      `Unmanaged or changed source pointer: ${paths.live}; preserve it and resolve ownership before installing`,
    );
  if (isPrimaryConsumer(paths)) {
    if (pointer(join(paths.cataly, "bin/omp")) !== nativeTarget(paths, state))
      throw new Error("Unmanaged or changed native OMP pointer; preserve it and resolve ownership before installing");
  } else preflightReferences(paths);
}

/** Full retained source and exec-bit verification is required for both activation and rollback. */
export function verifyRelease(paths: ConsumerPaths, manifest: ReleaseManifest): string {
  const path = releasePath(paths, manifest);
  realDirectory(path);
  owned(path);
  const recorded = validateReleaseManifest(readJson(manifestPath(paths, manifest)));
  if (JSON.stringify(recorded) !== JSON.stringify(manifest)) throw new Error("Retained release manifest differs");
  const observed = sourceManifest(path);
  assertSourceAdmission(observed, "upstream");
  if (!sameManifest(observed, manifest.source) || observed.excluded.length !== 0)
    throw new Error("Retained release source bytes or executable modes differ");
  assertLock(path, manifest);
  return path;
}

function removeState(paths: ConsumerPaths): void {
  if (regularFile(paths.state)) unlinkSync(paths.state);
  syncDirectory(paths.root);
}

/** Reconcile the only two allowed pointer positions; never guess around an externally changed path. */
function recoverInstalledUnlocked(paths: ConsumerPaths): InstalledState | undefined {
  const state = loadInstalled(paths);
  if (!regularFile(paths.journal)) {
    assertInstalledPointer(paths, state);
    return state;
  }
  const raw = readJson(paths.journal);
  if (
    !object(raw) ||
    raw["version"] !== 1 ||
    Object.keys(raw).some((key) => !["version", "before", "after"].includes(key))
  )
    throw new Error("Consumer activation journal is invalid");
  const journal: Journal = {
    version: 1,
    ...(raw["before"] === undefined ? {} : { before: validateState(raw["before"]) }),
    after: validateState(raw["after"]),
  };
  const same = (a: InstalledState | undefined, b: InstalledState | undefined) =>
    JSON.stringify(a) === JSON.stringify(b);
  if (!same(state, journal.before) && !same(state, journal.after))
    throw new Error("Installed state conflicts with interrupted activation");
  const actual = pointer(paths.live);
  const before = journal.before ? releasePath(paths, journal.before.current) : undefined;
  const after = releasePath(paths, journal.after.current);
  const omp = isPrimaryConsumer(paths) ? join(paths.cataly, "bin/omp") : undefined;
  const native = omp ? pointer(omp) : undefined;
  if (!omp) preflightReferences(paths);
  if (native !== nativeTarget(paths, journal.before) && native !== nativeTarget(paths, journal.after))
    throw new Error("Native OMP pointer conflicts with interrupted activation; preserve it for inspection");
  let recovered: InstalledState | undefined;
  if (actual === after) {
    verifyRelease(paths, journal.after.current);
    recovered = journal.after;
  } else if (actual === before) {
    if (journal.before) verifyRelease(paths, journal.before.current);
    recovered = journal.before;
  } else throw new Error("Source pointer conflicts with interrupted activation; preserve it for inspection");
  const expectedNative = nativeTarget(paths, recovered);
  assertNoLiveCataly(paths);
  if (omp && native !== expectedNative) replacePointer(omp, native, expectedNative);
  if (recovered) saveJson(paths.state, recovered);
  else removeState(paths);
  unlinkSync(paths.journal);
  syncDirectory(paths.root);
  return recovered;
}

export function recoverInstalled(paths: ConsumerPaths, launchOwner?: number): InstalledState | undefined {
  if (!regularFile(paths.journal)) return recoverInstalledUnlocked(paths);
  const unlock = acquireLaunchGate(paths);
  try {
    assertNoConsumerLaunches(paths, launchOwner);
    return recoverInstalledUnlocked(paths);
  } finally {
    unlock();
  }
}

type ActivationConfiguration = { readonly snapshot: SetupSnapshot; readonly beforeJournal?: () => void };

function activateReleaseUnlocked(
  paths: ConsumerPaths,
  before: InstalledState | undefined,
  after: InstalledState,
  configuration?: ActivationConfiguration,
): void {
  assertInstalledPointer(paths, before);
  if (before) verifyRelease(paths, before.current);
  const target = verifyRelease(paths, after.current);
  assertNoLiveCataly(paths);
  if (configuration) {
    assertSetupFile(configuration.snapshot);
    configuration.beforeJournal?.();
  }
  const journal: Journal = { version: 1, ...(before ? { before } : {}), after };
  saveJson(paths.journal, journal);
  const old = before ? releasePath(paths, before.current) : undefined;
  const omp = isPrimaryConsumer(paths) ? join(paths.cataly, "bin/omp") : undefined;
  const nativeBefore = nativeTarget(paths, before);
  const nativeAfter = nativeTarget(paths, after);
  try {
    if (omp && nativeBefore !== nativeAfter) replacePointer(omp, nativeBefore, nativeAfter);
    replacePointer(paths.live, old, target);
    saveJson(paths.state, after);
  } catch (error) {
    // The source pointer selects recovery if either rollback operation is itself interrupted.
    const source = pointer(paths.live);
    const native = omp ? pointer(omp) : undefined;
    if (source !== old && source !== target)
      throw new Error("Source pointer conflicts with interrupted activation; preserve it for inspection");
    if (native !== nativeBefore && native !== nativeAfter)
      throw new Error("Native OMP pointer conflicts with interrupted activation; preserve it for inspection");
    if (source === target) replacePointer(paths.live, target, old);
    if (omp && native !== nativeBefore) replacePointer(omp, native, nativeBefore);
    if (before) saveJson(paths.state, before);
    else removeState(paths);
    throw error;
  }
  unlinkSync(paths.journal);
  syncDirectory(paths.root);
}

export function activateRelease(
  paths: ConsumerPaths,
  before: InstalledState | undefined,
  after: InstalledState,
  launchOwner?: number,
  configuration?: ActivationConfiguration,
): void {
  const unlock = acquireLaunchGate(paths);
  try {
    assertNoConsumerLaunches(paths, launchOwner);
    activateReleaseUnlocked(paths, before, after, configuration);
  } finally {
    unlock();
  }
}

export function hasConsumerState(paths: ConsumerPaths): boolean {
  return (
    lstatSync(paths.state, { throwIfNoEntry: false }) !== undefined ||
    lstatSync(paths.journal, { throwIfNoEntry: false }) !== undefined
  );
}
