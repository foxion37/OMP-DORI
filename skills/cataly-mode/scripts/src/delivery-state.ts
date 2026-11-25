import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HEADLESS_ADDRESS, type SessionRef } from "../../../../src/runtime/types.ts";
import { LANE_KEY, type Registry } from "./registry.ts";

/** A local dispatch identity, not a native receipt or evidence that the requested action ran. */
export type DeliveryRecord = {
  readonly id: string;
  readonly openedAt: string;
  readonly session: SessionRef;
  readonly at: string;
  readonly status: "uncertain" | "confirmed" | "failed" | "released";
  readonly settledAt?: string;
  readonly note?: string;
};

/** The latest dispatch survives registry replacements. Writers must hold the lane's delivery lock. */
export class DeliveryState {
  readonly path: string;
  constructor(registry: Registry, key: string) {
    if (!LANE_KEY.test(key)) throw new Error(`invalid lane key: ${key}`);
    // Not *.json: Registry.list reads those as lane registrations.
    this.path = join(registry.dir, `${key}.delivery`);
  }

  read(): DeliveryRecord | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const value = JSON.parse(raw) as Partial<DeliveryRecord> | null;
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.id !== "string" ||
      !value.id ||
      typeof value.openedAt !== "string" ||
      !value.openedAt ||
      typeof value.at !== "string" ||
      !Number.isFinite(Date.parse(value.at)) ||
      !value.session ||
      typeof value.session.id !== "string" ||
      !value.session.id ||
      (value.session.runtime === "headless"
        ? !HEADLESS_ADDRESS.test(value.session.id)
        : value.session.runtime !== "tern") ||
      !["uncertain", "confirmed", "failed", "released"].includes(value.status ?? "") ||
      (value.settledAt !== undefined &&
        (typeof value.settledAt !== "string" || !Number.isFinite(Date.parse(value.settledAt)))) ||
      (value.note !== undefined && typeof value.note !== "string") ||
      (value.status === "released" && (!value.settledAt || !value.note?.trim()))
    )
      throw new Error(`invalid delivery state: ${this.path}; no delivery is allowed until it is repaired`);
    return value as DeliveryRecord;
  }

  write(value: DeliveryRecord): void {
    const temp = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      if (process.platform === "win32") return;
      // A newly registered lane may also have created the lanes directory.
      for (const path of [dirname(this.path), dirname(dirname(this.path))]) {
        const dir = openSync(path, "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
