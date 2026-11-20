import { isReportKind, type ReportKind } from "./reports.ts";

export type FreshnessPolicy = {
  readonly nudge?: "all" | "idle-only";
  readonly autoPostKinds?: readonly ReportKind[];
  readonly postRaw?: boolean;
};

export const freshnessError = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "invalid freshness: expected an object";
  for (const [name, setting] of Object.entries(value)) {
    const valid =
      name === "nudge"
        ? setting === "all" || setting === "idle-only"
        : name === "postRaw"
          ? typeof setting === "boolean"
          : name === "autoPostKinds"
            ? Array.isArray(setting) && setting.every(isReportKind)
            : false;
    if (!valid)
      return `invalid freshness.${name}: expected nudge=all|idle-only, postRaw=boolean, autoPostKinds=report kinds`;
  }
  return null;
};
