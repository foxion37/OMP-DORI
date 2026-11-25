import type { MonitorSpec } from "./deployment-types.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Normalize only explicit policy; persistent specs without a mode retain their original shape. */
export function monitorPolicy(
  value: Record<string, unknown>,
): Pick<MonitorSpec, "mode" | "restart" | "silentAfterMin"> {
  const mode = value["mode"];
  if (mode !== undefined && mode !== "persistent" && mode !== "once" && mode !== "daemon")
    throw new Error("invalid specification: unsupported monitor mode");
  const silent = value["silentAfterMin"];
  if (
    silent !== undefined &&
    (typeof silent !== "number" || !Number.isFinite(silent) || silent <= 0 || silent * 60_000 > 2_147_483_647)
  )
    throw new Error("silentAfterMin must be positive and fit the timer range");
  if (
    mode !== "daemon" &&
    value["restart"] !== undefined &&
    value["restart"] !== "on-failure" // once-mode retry, admitted separately from daemon policy
  )
    throw new Error("restart requires daemon mode");
  const restart =
    mode === "daemon" ? (value["restart"] === undefined ? { max: 5, backoffSec: 10 } : value["restart"]) : undefined;
  if (
    restart !== undefined &&
    (!record(restart) ||
      Object.keys(restart).some((key) => key !== "max" && key !== "backoffSec") ||
      typeof restart["max"] !== "number" ||
      !Number.isSafeInteger(restart["max"]) ||
      restart["max"] < 0 ||
      restart["max"] > 100 ||
      typeof restart["backoffSec"] !== "number" ||
      !Number.isFinite(restart["backoffSec"]) ||
      restart["backoffSec"] <= 0 ||
      restart["backoffSec"] * 1000 > 2_147_483_647)
  )
    throw new Error("daemon restart needs max 0..100 and positive backoffSec within the timer range");
  return {
    ...(mode === "once" || mode === "daemon" ? { mode } : {}),
    ...(restart === undefined
      ? value["restart"] === "on-failure"
        ? { restart: "on-failure" as const }
        : {}
      : { restart: { max: restart["max"] as number, backoffSec: restart["backoffSec"] as number } }),
    ...(silent === undefined ? {} : { silentAfterMin: silent as number }),
  };
}
