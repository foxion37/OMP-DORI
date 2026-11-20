import { join } from "node:path";
import { type ConsumerPaths, readJson, regularFile, saveJson } from "./files.ts";

export type AutomaticState = {
  readonly version: 1;
  readonly enabled: boolean;
  readonly nextCheck: number;
  readonly lastAttempt?: number;
  readonly outcome?: "current" | "installed" | "held" | "failed" | "rollback";
  readonly available?: string;
  readonly detail?: string;
};
const file = (paths: ConsumerPaths): string => join(paths.root, "consumer-automatic.json");

/** Scheduling metadata never changes the preserved user config or the installed release receipt. */
export function readAutomaticState(paths: ConsumerPaths): AutomaticState {
  if (!regularFile(file(paths))) return { version: 1, enabled: true, nextCheck: 0 };
  const state = readJson(file(paths)) as AutomaticState;
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    state.version !== 1 ||
    typeof state.enabled !== "boolean" ||
    !Number.isSafeInteger(state.nextCheck) ||
    state.nextCheck < 0 ||
    Object.keys(state).some(
      (key) => !["version", "enabled", "nextCheck", "lastAttempt", "outcome", "available", "detail"].includes(key),
    ) ||
    (state.lastAttempt !== undefined && (!Number.isSafeInteger(state.lastAttempt) || state.lastAttempt < 0)) ||
    (state.outcome !== undefined && !["current", "installed", "held", "failed", "rollback"].includes(state.outcome)) ||
    (state.available !== undefined && !/^v\d+\.\d+\.\d+$/.test(state.available)) ||
    (state.detail !== undefined && (typeof state.detail !== "string" || state.detail.length > 500))
  )
    throw new Error("Invalid automatic release update metadata");
  return state;
}

export function saveAutomaticState(paths: ConsumerPaths, state: AutomaticState): void {
  readAutomaticState(paths);
  saveJson(file(paths), state);
}

export function setAutomaticEnabled(paths: ConsumerPaths, enabled: boolean, rollback = false): AutomaticState {
  const previous = readAutomaticState(paths);
  const state: AutomaticState = {
    version: 1,
    enabled,
    nextCheck: 0,
    ...(previous.lastAttempt === undefined ? {} : { lastAttempt: previous.lastAttempt }),
    ...(rollback ? { outcome: "rollback" } : {}),
  };
  saveAutomaticState(paths, state);
  return state;
}
