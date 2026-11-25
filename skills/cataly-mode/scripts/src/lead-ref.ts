import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRef, type RuntimeKind, type SessionRef } from "../../../../src/runtime/types.ts";
import type { CatalyConfig } from "./config.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";

type LeadAddress =
  | { readonly ref: SessionRef }
  | { readonly reason: "invalid"; readonly unboundAlias?: boolean }
  | { readonly reason: "unconfigured" | "ambiguous" | "unreadable" };

/** A default for new sessions is never evidence about the address of an existing lead. */
export function leadAddress(
  config: Pick<CatalyConfig, "leadPane">,
  env: Readonly<Record<string, string | undefined>>,
): LeadAddress {
  let recorded: SessionRef | undefined;
  const home = env["CATALY_HOME"] ?? (env["HOME"] ? join(env["HOME"], ".cataly") : undefined);
  try {
    const roles: unknown = home ? JSON.parse(readFileSync(join(home, "roles.json"), "utf8")) : {};
    if (!roles || typeof roles !== "object" || Array.isArray(roles)) return { reason: "invalid" };
    if ("lead" in roles) {
      recorded = typeof roles.lead === "string" ? parseRef(roles.lead) : undefined;
      if (!recorded) return { reason: "invalid" };
    }
    if (recorded)
      for (const name of ["duty", "duty-loop", "hourly-loop"]) {
        const value = (roles as Record<string, unknown>)[name];
        const ref = typeof value === "string" ? parseRef(value) : undefined;
        if (ref?.id === recorded.id && ref.runtime === recorded.runtime) return { reason: "ambiguous" };
      }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { reason: "unreadable" };
  }
  const pane = config.leadPane.trim();
  if (!pane) return recorded ? { ref: recorded } : { reason: "unconfigured" };
  const explicit = parseRef(pane);
  if (!explicit) return recorded ? { reason: "ambiguous" } : { reason: "invalid", unboundAlias: true };
  if (recorded && (recorded.runtime !== explicit.runtime || recorded.id !== explicit.id))
    return { reason: "ambiguous" };
  return { ref: explicit };
}

export const hasTerminalScope = (
  selected: RuntimeKind | undefined,
  lanes: readonly Lane[],
  lead?: SessionRef,
): boolean =>
  (selected !== undefined && selected !== "headless") ||
  (lead !== undefined && lead.runtime !== "headless") ||
  lanes.some((lane) => {
    const ref = sessionOf(lane);
    return statusOf(lane) !== "closed" && ref !== undefined && ref.runtime !== "headless";
  });
