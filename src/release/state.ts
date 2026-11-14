import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { assertSourceAdmission, sameManifest, sourceManifest } from "../update/source.ts";
import {
  type ConsumerPaths,
  owned,
  pointer,
  readJson,
  realDirectory,
  regularFile,
  replacePointer,
  saveJson,
  syncDirectory,
} from "./files.ts";
import { assertNoLiveDori } from "./live.ts";
import { validateReleaseManifest } from "./manifest.ts";
import { assertLock } from "./provision.ts";
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
export function recoverInstalled(paths: ConsumerPaths): InstalledState | undefined {
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
  let recovered: InstalledState | undefined;
  if (actual === after) {
    verifyRelease(paths, journal.after.current);
    saveJson(paths.state, journal.after);
    recovered = journal.after;
  } else if (actual === before) {
    if (journal.before) {
      verifyRelease(paths, journal.before.current);
      saveJson(paths.state, journal.before);
    } else removeState(paths);
    recovered = journal.before;
  } else throw new Error("Source pointer conflicts with interrupted activation; preserve it for inspection");
  unlinkSync(paths.journal);
  syncDirectory(paths.root);
  return recovered;
}

export function activateRelease(paths: ConsumerPaths, before: InstalledState | undefined, after: InstalledState): void {
  assertInstalledPointer(paths, before);
  if (before) verifyRelease(paths, before.current);
  const target = verifyRelease(paths, after.current);
  assertNoLiveDori(paths);
  const journal: Journal = { version: 1, ...(before ? { before } : {}), after };
  saveJson(paths.journal, journal);
  const old = before ? releasePath(paths, before.current) : undefined;
  try {
    replacePointer(paths.live, old, target);
    saveJson(paths.state, after);
  } catch (error) {
    // If state publication failed, restore the previous pointer. The durable journal covers another interruption.
    if (pointer(paths.live) === target) replacePointer(paths.live, target, old);
    if (before) saveJson(paths.state, before);
    else removeState(paths);
    throw error;
  }
  unlinkSync(paths.journal);
  syncDirectory(paths.root);
}

export function hasConsumerState(paths: ConsumerPaths): boolean {
  return (
    lstatSync(paths.state, { throwIfNoEntry: false }) !== undefined ||
    lstatSync(paths.journal, { throwIfNoEntry: false }) !== undefined
  );
}
