import type { DeploymentRecord, ToolchainReceipt } from "./deployment-types.ts";

/*
 * THE FIRST OF TWO ONE-WAY BRIDGES FROM THE PREVIOUS MAIN (the release before the legacy removal).
 *
 * A lead that release started writes its runtime health with `presetLoaded` instead of `configLoaded`, and its
 * controller recorded toolchain receipts that pin the Cataly extension through an `ompUlw` overlay instead of
 * `extensionSource`. Read in the current shape, they let this controller replace such a lead through the ordinary
 * managed path: the releasing source's own `cataly harness stop`, the pointer switch, the new release's `cataly harness
 * up` resuming the recorded lead session, health readback and, on failure, rollback to the same lead session. Every
 * other check and hold is unchanged. Nothing writes these shapes any more; delete this file with the next release.
 *
 * The second bridge is the session-entry one in `extension/session-bridge.ts`. On the first resume of a session the
 * previous main wrote, the extension appends that session's `omp-cataly:*` entries once, the current form of its
 * `omp-dori:*` entries (role `dori` becomes `cataly`, newest state per type), and never rewrites the transcript; a
 * second resume appends nothing. So the lead this file resumes keeps its role, monitors, intake and lane policy, and
 * the health readback above compares that against the desired monitor set captured for the deployment. `dori-monitor`
 * messages are read there, never written: the writer stays `cataly-monitor`.
 */

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Previous-main runtime health in the current shape; anything else is returned as it is, for ordinary validation. */
export function currentHealth(value: unknown): unknown {
  if (!object(value) || "configLoaded" in value || typeof value["presetLoaded"] !== "boolean") return value;
  const { presetLoaded, ...health } = value;
  return { ...health, configLoaded: presetLoaded };
}

/** A previous-main receipt pinned `ompUlw.source/extension`; the current receipt names that source directly. */
export function currentReceipt<T extends ToolchainReceipt | undefined>(receipt: T): T {
  if (!object(receipt) || "extensionSource" in receipt) return receipt;
  const { ompUlw, ...rest } = receipt as Record<string, unknown>;
  if (!object(ompUlw) || typeof ompUlw["source"] !== "string") return receipt;
  return { ...rest, extensionSource: ompUlw["source"] } as unknown as T;
}

/** A transaction journal the previous main's controller wrote, with both of its receipts in the current shape. */
export function currentRecord<T extends DeploymentRecord | undefined>(record: T): T {
  if (!record) return record;
  const toolchain = currentReceipt(record.toolchain);
  const oldToolchain = currentReceipt(record.oldToolchain);
  if (toolchain === record.toolchain && oldToolchain === record.oldToolchain) return record;
  return { ...record, ...(toolchain ? { toolchain } : {}), ...(oldToolchain ? { oldToolchain } : {}) };
}
