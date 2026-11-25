import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { SessionRef } from "../../../../src/runtime/types.ts";
import { withRegistryLock } from "./checkpoint-lock.ts";
import type { ModelReadback } from "./lane-state.ts";
import type { NativeCloseIntent } from "./native-close.ts";
import type { ReportDelivery } from "./request-identity.ts";
import type { BudgetLimits } from "./supervision-observe.ts";

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;
// `lead` names the lead, never a lane: records the lead writes (lessons with `lane: "lead"`) and lead-only checks tell
// the two apart by this key, so launch and adopt refuse it. LANE_KEY stays as it is because those records still carry
// it, and keys are lowercase-only, so the exact match is the whole check.
export const RESERVED_LANE_KEY = "lead";

export type LaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "closed";
export type Claim = { readonly at: string; readonly evidence: string; readonly emitted?: boolean };
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };

export type Lane = {
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  /** Original physical input, immutable across reopen and wake; never a display title. */
  readonly requestId?: string;
  /** Local launch invocation, not a native admission or completion receipt. */
  readonly runId?: string;
  /** The lane's session on its runtime. */
  readonly sessionRef?: SessionRef;
  readonly session?: string;
  readonly sessionFile?: string;
  readonly sessionVia?: string;
  /** Prior verified registry bindings, not arbitrary journal ancestors. */
  readonly priorSessions?: readonly string[];
  /** Terminal intent and operator-defined condition; never an automatic resume trigger. */
  readonly hold?: { readonly reason: string; readonly resumeWhen?: string; readonly outcome?: "parked" | "abandoned" };
  readonly brief: string;
  readonly done: string;
  readonly cwd?: string;
  readonly model?: string;
  /** Launch-time model evidence, not the session's current model after an explicit switch. */
  readonly modelReadback?: ModelReadback;
  readonly launchSelection?: import("./launch-selection.ts").LaunchSelection;
  readonly worktrees?: readonly string[];
  readonly status?: LaneStatus;
  readonly claim?: Claim;
  readonly objection?: Objection;
  readonly history?: readonly HistoryEntry[];
  readonly openedAt: string;
  readonly lifecycleEpoch?: string;
  readonly nativeCloseIntent?: NativeCloseIntent;
  readonly threadClosePending?: true;
  readonly closedAt?: string;
  readonly lastReplyAt?: number;
  readonly lastNudgeAt?: number;
  readonly lastAutoReplyAt?: number;
  readonly lastPostedReport?: string | undefined;
  readonly lastPostedReportId?: string | undefined;
  readonly lastPostedReportOwner?: string | undefined;
  readonly lastPostedReportDelivery?: ReportDelivery | undefined;
  readonly lastRelayedAt?: number;
  readonly lastNudgeFailure?: string | undefined;
  /** The [REPORT] line seen on the previous freshness tick (a line is posted only once it holds across two ticks). */
  readonly lastSeenReport?: string | undefined;
  /** The last held-back freshness outcome, so a quiet lane logs each state change once, not every tick. */
  readonly lastFreshnessNote?: string | undefined;
  readonly lastNativeHold?: string | undefined;
  readonly lastWaitNotice?: string | undefined; // Advisory wait outcome, separate from thread posting notes.
  /** A paused lane whose pane read working on the previous freshness tick (two in a row is reported, never a resume). */
  readonly pausedSeenWorking?: boolean | undefined;
  /** The status a paused lane had before it was paused; `resume` restores it. */
  readonly pausedFrom?: LaneStatus | undefined;
  readonly reportProtocol?: "jsonl-v1" | undefined;
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
  /** The last supervision failure printed by `freshness`, so the same one is printed once. */
  readonly lastSupervisionError?: string | undefined;
  readonly receipt?: unknown;
};

export const sessionOf = (lane: Lane): SessionRef | undefined => lane.sessionRef;

/** The fields a lane record stores for a session. */
export const sessionFields = (ref: SessionRef): Pick<Lane, "sessionRef"> => ({ sessionRef: ref });

const sameSession = (a: SessionRef | undefined, b: SessionRef): boolean =>
  a !== undefined && a.runtime === b.runtime && a.id === b.id;

export const statusOf = (lane: Lane): LaneStatus => (lane.closedAt ? "closed" : (lane.status ?? "working"));

// Only a status transition or a new open epoch invalidates an in-flight decision.
export const sameLaneGeneration = (seen: Lane, current: Lane): boolean =>
  seen.openedAt === current.openedAt &&
  seen.lifecycleEpoch === current.lifecycleEpoch &&
  (seen.history?.length ?? 0) === (current.history?.length ?? 0) &&
  statusOf(seen) === statusOf(current);
/**
 * The lane's status generation: every status change (a claim, objection, verification, pause, resume or close) goes
 * through `withStatus` and appends one history entry, even when the status stays the same, as a second objection does.
 * Bookkeeping fields (freshness notes, `claim.emitted`, a receipt) leave it as it is.
 */
export const generation = (lane: Lane): string => `${lane.openedAt} ${lane.history?.length ?? 0} ${statusOf(lane)}`;

export const withStatus = (
  lane: Lane,
  status: LaneStatus,
  note: string,
  at: string,
  patch: Partial<Lane> = {},
): Lane => ({
  ...lane,
  ...patch,
  status,
  history: [...(lane.history ?? []), { at, status, note }],
});

export class Registry {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "lanes");
  }

  path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<Lane | null> {
    return this.readNow(key);
  }

  /**
   * Runs `fn` under the lane's writer lock. `fn` is synchronous, so the lock is held for one read and one write and
   * never across pane, git or network I/O. Another writer's lock is waited out; a dead or stale one is taken over.
   */
  private locked<T>(key: string, fn: () => T): Promise<T> {
    return withRegistryLock({ directory: this.dir, path: this.path(key), key }, fn);
  }

  /** A synchronous journal operation on the current lane, without rewriting its registration. */
  withCurrent<T>(key: string, fn: (current: Lane | null) => T): Promise<T> {
    return this.locked(key, () => fn(this.readNow(key)));
  }

  /** A missing record is null; a present one that is not a JSON object is unreadable, never mistaken for missing. */
  private readNow(key: string): Lane | null {
    let lane: unknown;
    try {
      lane = JSON.parse(readFileSync(this.path(key), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (lane === null || typeof lane !== "object") throw new Error(`lane record ${key} is not an object`);
    return lane as Lane;
  }
  private writeNow(lane: Lane): void {
    const tmp = `${this.path(lane.key)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(lane, null, 1));
    renameSync(tmp, this.path(lane.key));
  }
  async write(lane: Lane): Promise<void> {
    await this.locked(lane.key, () => this.writeNow(lane));
  }
  /** Registers a new lane only while its key has no record (false: another launch or adopt holds the key). */
  async create(lane: Lane): Promise<boolean> {
    return (await this.update(lane.key, (current) => (current ? null : lane))) !== null;
  }
  /** Removes `lane`'s record while it is still that registration: a launch undoing its own failed start. */
  discard(lane: Lane): Promise<void> {
    return this.locked(lane.key, () => {
      const current = this.readNow(lane.key);
      if (current && sameLaneGeneration(lane, current)) rmSync(this.path(lane.key), { force: true });
    });
  }
  /**
   * Read-modify-write of one lane under its lock: `fn` gets the stored lane (or null) and returns the lane to store, or
   * null to leave it. A lane held across I/O is changed here, never written back whole, so a change meanwhile is kept.
   */
  update(key: string, fn: (current: Lane | null) => Lane | null): Promise<Lane | null> {
    return this.locked(key, () => {
      const next = fn(this.readNow(key));
      if (next) this.writeNow(next);
      return next;
    });
  }
  /** Apply a decision only while the lane still has the observed generation. */
  transition(seen: Lane, next: (current: Lane) => Lane | null): Promise<Lane | null> {
    return this.update(seen.key, (current) => (current && sameLaneGeneration(seen, current) ? next(current) : null));
  }
  private files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(this.dir, f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  async list(): Promise<Lane[]> {
    return this.files()
      .map((f) => this.readNow(basename(f, ".json")))
      .filter((lane) => lane !== null);
  }
  /** Isolate unreadable and miskeyed rows; strict scans also flag a row that vanishes during the read. */
  async scan(strict = false): Promise<{ lanes: Lane[]; unreadable: string[] }> {
    return this.scanNow(strict);
  }
  scanNow(strict = false): { lanes: Lane[]; unreadable: string[] } {
    const lanes: Lane[] = [];
    const unreadable: string[] = [];
    for (const f of this.files()) {
      try {
        const lane: unknown = this.readNow(basename(f, ".json"));
        if (lane === null && !strict) continue;
        if (lane && typeof lane === "object" && "key" in lane && lane.key === basename(f, ".json"))
          lanes.push(lane as Lane);
        else unreadable.push(f);
      } catch {
        unreadable.push(f);
      }
    }
    return { lanes, unreadable };
  }
  async open(): Promise<Lane[]> {
    return (await this.list()).filter((l) => statusOf(l) !== "closed");
  }
  /** The open lane in ref. */
  async bySession(ref: SessionRef | undefined): Promise<Lane | null> {
    if (!ref) return null;
    return (await this.open()).find((l) => sameSession(l.sessionRef, ref)) ?? null;
  }
}
