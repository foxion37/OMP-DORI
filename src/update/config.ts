import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export class UpdateError extends Error {}
/** The controller cannot prove a child/model run ended cleanly; the candidate is held for explicit recovery. */
export class UpdateInterrupted extends UpdateError {}
/** A completed detector attempt failed without creating or owning candidate work; the resident loop may retry. */
export class UpdateDetectionUnavailable extends UpdateError {}

export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function hasControl(value: string, includeDel = false): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || (includeDel && code === 127)) return true;
  }
  return false;
}

/** Resolve existing ancestors too: a symlink must not turn a dedicated output into the live source. */
export function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonical(parent), relative(parent, path));
}

export const contains = (parent: string, child: string): boolean =>
  parent === sep || child === parent || child.startsWith(`${parent}${sep}`);
