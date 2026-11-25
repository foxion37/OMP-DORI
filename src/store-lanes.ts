import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alive } from "../skills/cataly-mode/scripts/src/checkpoint-lock.ts";
import { takeFile } from "./lock-claim.ts";
import { readWait } from "./wait.ts";
import { Refusal } from "./refusal.ts";
import { sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { Lane } from "./store-types.ts";

const readLane = (raw: Lane): Lane => {
  const { wait: saved, ...rest } = raw;
  const wait = readWait(saved);
  return { ...rest, ...(wait ? { wait } : {}) };
};

export const rootStoreHome = (): string => process.env["CATALY_HOME"] ?? join(homedir(), ".cataly");

export function readRootLane(root: string, key: string): Lane | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(root, "lanes", `${key}.json`), "utf8")) as Lane | null;
    return raw ? readLane(raw) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Match an incarnation, even when a terminal backend recycles its ref and the clock repeats. */
export const sameLaneRegistration = (seen: Lane, current: Lane): boolean =>
  seen.key === current.key &&
  seen.createdAt === current.createdAt &&
  seen.noticeId === current.noticeId &&
  sameSession(seen.sessionRef, current.sessionRef);

export class RootLaneStore {
  constructor(readonly root: string) {}

  lane(key: string): Lane | undefined {
    return readRootLane(this.root, key);
  }

  /** One synchronous operation on the current root registration; never hold the writer lock across I/O awaits. */
  withCurrentLane<T>(key: string, fn: (current: Lane | undefined, save: (lane: Lane) => void) => T): T {
    const path = join(this.root, "lanes", `${key}.root.lock`);
    const held = takeFile({ pid: process.pid, now: Date.now, alive }, path, 60_000);
    if (!held) throw new Refusal(`lane ${key} registration is being written`);
    try {
      return fn(this.lane(key), (lane) => {
        if (lane.key !== key) throw new Refusal(`cannot write lane ${lane.key} under lane ${key}'s lock`);
        const file = join(this.root, "lanes", `${key}.json`);
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(lane, null, 2) + "\n");
        renameSync(tmp, file);
      });
    } finally {
      held();
    }
  }

  updateLane(key: string, update: (current: Lane | undefined) => Lane): Lane;
  updateLane(key: string, update: (current: Lane | undefined) => Lane | undefined): Lane | undefined;
  updateLane(key: string, update: (current: Lane | undefined) => Lane | undefined): Lane | undefined {
    return this.withCurrentLane(key, (current, save) => {
      const next = update(current);
      if (next) save(next);
      return next;
    });
  }

  saveLane(lane: Lane): void {
    this.updateLane(lane.key, () => lane);
  }

  lanes(): Lane[] {
    return readdirSync(join(this.root, "lanes"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.lane(f.slice(0, -5)))
      .filter((lane): lane is Lane => lane !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  }

  laneBySession(ref: SessionRef): Lane | undefined {
    return this.lanes().find((l) => sameSession(l.sessionRef, ref) && l.status !== "done");
  }
}
