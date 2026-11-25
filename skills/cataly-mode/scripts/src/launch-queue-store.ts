import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaunchInput } from "./launch-input.ts";
import { LANE_KEY } from "./registry.ts";
import { QueueError } from "./launch-errors.ts";
import { isRequestId } from "./request-identity.ts";

export type QueueEntry = {
  readonly id: string;
  /** `cwd` is the canonical directory resolved at enqueue. */
  readonly input: LaunchInput & { readonly cwd: string };
  readonly briefText: string;
  readonly after: readonly string[];
  readonly queuedAt: string;
  readonly expiresAt: string;
  readonly status: "pending" | "starting" | "started" | "cancelled";
  readonly lastNotice?: string;
};

/** Per-key records are replaced atomically under the lane launch lock. */
export class LaunchQueue {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "launch-queue");
  }
  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new QueueError(`invalid queue key: ${key}`);
    return join(this.dir, `${key}.json`);
  }
  read(key: string): QueueEntry | null {
    let raw: string;
    try {
      raw = readFileSync(this.path(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let entry: QueueEntry;
    try {
      entry = JSON.parse(raw) as QueueEntry;
    } catch {
      throw new QueueError(`invalid queue JSON: ${key}`);
    }
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(entry.id) ||
      entry.input?.key !== key ||
      typeof entry.input.title !== "string" ||
      typeof entry.input.brief !== "string" ||
      typeof entry.input.done !== "string" ||
      typeof entry.input.cwd !== "string" ||
      (entry.input.requestId !== undefined && !isRequestId(entry.input.requestId)) ||
      typeof entry.briefText !== "string" ||
      !Array.isArray(entry.after) ||
      entry.after.length === 0 ||
      !entry.after.every((item) => typeof item === "string" && LANE_KEY.test(item)) ||
      !["pending", "starting", "started", "cancelled"].includes(entry.status) ||
      !Number.isFinite(Date.parse(entry.expiresAt))
    )
      throw new QueueError(`invalid queue record: ${key}`);
    return entry;
  }
  write(entry: QueueEntry): void {
    mkdirSync(this.dir, { recursive: true });
    const path = this.path(entry.input.key);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }
  scan(): { entries: QueueEntry[]; problems: string[] } {
    let files: string[];
    const entries: QueueEntry[] = [],
      problems: string[] = [];
    try {
      files = readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries, problems };
      throw error;
    }
    for (const name of files.filter((name) => name.endsWith(".json")).sort()) {
      try {
        const entry = this.read(name.slice(0, -5));
        if (entry) entries.push(entry);
      } catch (error) {
        problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { entries, problems };
  }
}
