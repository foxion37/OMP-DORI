import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Checkpoints } from "./checkpoints.ts";
import { fill } from "./config.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { type Registry, sameLaneGeneration } from "./registry.ts";
import { type Progress, Reports } from "./reports.ts";
import type { Clock, Runner } from "./run.ts";
import {
  laneActivity,
  observeBudget,
  type SupervisedLane,
  type SupervisionOptions,
  type Usage,
  type UsageSnapshot,
  workingTimer,
} from "./supervision-observe.ts";

export type SupervisionDeps = {
  readonly stateDir: string;
  readonly run: Runner;
  readonly reports?: Reports;
  readonly alert?: (lane: SupervisedLane, message: string) => void | Promise<void>;
} & (
  | { readonly registry: Registry; readonly clock: Clock }
  | { readonly registry?: undefined; readonly clock: Pick<Clock, "now"> }
);
export type SupervisionResult = {
  readonly enabled: boolean;
  readonly state: "running" | "stalled" | "blocked" | "halted" | "done" | null;
  readonly alerts: readonly string[];
  readonly usage: UsageSnapshot | null;
  readonly hung: boolean;
};
const NOT_OBSERVED: SupervisionResult = { enabled: false, state: null, alerts: [], usage: null, hung: false };

type Observation = {
  readonly openedAt: string;
  readonly generation?: string;
  readonly at: number;
  readonly timer: number | null;
  readonly timerKind: string | null;
  readonly activity: string;
  readonly activeAt: number;
  readonly alerts: readonly string[];
};

export class Supervision {
  readonly reports: Reports;
  readonly checkpoints: Checkpoints;
  constructor(
    readonly deps: SupervisionDeps,
    readonly options: SupervisionOptions = {},
  ) {
    this.reports = deps.reports ?? new Reports(deps.stateDir);
    this.checkpoints = new Checkpoints(deps.stateDir);
  }

  private enabled(lane: SupervisedLane): boolean {
    return lane.reportProtocol === "jsonl-v1" || existsSync(this.reports.path(lane.key));
  }

  private async usage(lane: SupervisedLane, now: number): Promise<UsageSnapshot> {
    let usage: Usage = { tokens: null, costUsd: null };
    if (this.options.usageArgv?.length) {
      const result = await this.deps.run(
        fill(this.options.usageArgv, { key: lane.key, session: lane.session ?? "", cwd: lane.cwd ?? "" }),
        { ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 },
      );
      if (result.code === 0) {
        try {
          const value: unknown = JSON.parse(result.out);
          const metric = (name: "tokens" | "costUsd"): number | null => {
            const n =
              typeof value === "object" && value !== null && name in value
                ? (value as Record<string, unknown>)[name]
                : null;
            return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
          };
          usage = { tokens: metric("tokens"), costUsd: metric("costUsd") };
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // Malformed external JSON remains unknown, never zero.
        }
      }
    }
    return { key: lane.key, openedAt: lane.openedAt, at: new Date(now).toISOString(), ...usage };
  }

  private costPath(key: string): string {
    return join(dirname(this.reports.path(key)), "cost.jsonl");
  }

  private record(snapshot: UsageSnapshot): void {
    const path = this.costPath(snapshot.key);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  }

  async sweep(lane: SupervisedLane, screen: string): Promise<SupervisionResult> {
    if (!this.enabled(lane)) return NOT_OBSERVED;
    const now = this.deps.clock.now();
    const signature = await laneActivity(this.deps.run, this.options, this.checkpoints, lane);
    const usage = await this.usage(lane, now);
    const deps = this.deps;
    if (deps.registry === undefined) return this.applySweep(lane, screen, now, usage, signature);
    const held = await withDeliveryLock(deps, lane.key, async () => {
      const current = await deps.registry.read(lane.key);
      if (!current || current.nativeCloseIntent || !sameLaneGeneration(lane, current)) return NOT_OBSERVED;
      return this.applySweep(lane, screen, now, usage, signature);
    });
    return held.ok ? held.value : NOT_OBSERVED;
  }

  private async applySweep(
    lane: SupervisedLane,
    screen: string,
    now: number,
    usage: UsageSnapshot,
    signature: (progress: Progress | null) => string,
  ): Promise<SupervisionResult> {
    const scope = { generation: lane.lifecycleEpoch };
    const tag = scope.generation === undefined ? {} : { generation: scope.generation };
    const path = join(dirname(this.reports.path(lane.key)), "supervision.json");
    const saved = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Observation) : null;
    const previous = saved?.openedAt === lane.openedAt && saved.generation === scope.generation ? saved : null;
    const progress = this.reports.read(lane.key, scope);
    // Without a usage hook each sweep would append the same unknown reading; close still records its final one.
    if (this.options.usageArgv?.length) this.record(usage);
    const activity = signature(progress);
    const timer = workingTimer(screen);
    const activeAt = !previous || activity !== previous.activity ? now : previous.activeAt;
    const { violations, unavailable } = observeBudget(this.options, lane, now, usage);
    const hung =
      previous !== null &&
      timer !== null &&
      previous.timer !== null &&
      timer.kind === previous.timerKind &&
      timer.seconds > previous.timer &&
      // A changed timer origin means a new call, even if its duration is larger. Rounding to the shown unit moves the
      // computed origin by up to one unit, plus sweep jitter.
      Math.abs(now - timer.seconds * 1000 - (previous.at - previous.timer * 1000)) <= timer.step * 1000 + 2000 &&
      timer.seconds >= (this.options.hungAfterMinutes ?? 20) * 60 &&
      now - activeAt >= (this.options.staleAfterMinutes ?? 20) * 60_000;
    const terminal = progress?.state === "done" || progress?.state === "halted";
    const hungMessage = "Working/Running timer exceeded threshold without fresh report, checkpoint, or file activity";
    const alerts = terminal ? [] : [...(violations.length ? violations : hung ? [hungMessage] : []), ...unavailable];
    const freshAlerts = alerts.filter((message) => !previous?.alerts.includes(message));
    // A question also reads as blocked; only this same ceiling blocker as the latest report makes a new one a repeat.
    const blocker = violations.join("; ");
    const reported = progress?.lastReport?.kind === "blocker" && progress.lastReport.text === blocker;
    if (!terminal && violations.length && !reported) {
      this.reports.report(lane.key, "blocker", blocker, now, scope.generation);
    } else if (!terminal && hung && (!progress || progress.state === "running")) {
      this.reports.append({
        type: "activity",
        key: lane.key,
        ...tag,
        at: new Date(now).toISOString(),
        state: "stalled",
        text: hungMessage,
      });
    } else if (!alerts.length && progress?.state === "stalled" && activity !== previous?.activity) {
      this.reports.append({
        type: "activity",
        key: lane.key,
        ...tag,
        at: new Date(now).toISOString(),
        state: "running",
        text: "Fresh report, checkpoint, or file activity observed",
      });
    }
    // Deliver before saving, so only alerts that reached the callback count as sent; a failed one is sent again next sweep.
    const undelivered = new Map<string, string>();
    for (const message of freshAlerts) {
      try {
        await this.deps.alert?.(lane, message);
      } catch (error) {
        undelivered.set(message, error instanceof Error ? error.message : String(error));
      }
    }
    // Save the post-blocker signature so our own report does not count as progress.
    const latest = this.reports.read(lane.key, scope);
    const observation: Observation = {
      openedAt: lane.openedAt,
      ...tag,
      at: now,
      timer: timer?.seconds ?? null,
      timerKind: timer?.kind ?? null,
      activity: signature(latest),
      activeAt,
      alerts: alerts.filter((message) => !undelivered.has(message)),
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(observation), { mode: 0o600 });
    renameSync(temporary, path);
    if (undelivered.size)
      throw new Error(
        `alert delivery failed for ${lane.key}: ${[...undelivered].map(([message, why]) => `${message} (${why})`).join("; ")}`,
      );
    return { enabled: true, state: latest?.state ?? "running", alerts: freshAlerts, usage, hung };
  }

  async close(lane: SupervisedLane): Promise<UsageSnapshot | null> {
    if (!this.enabled(lane)) return null;
    // Record each openedAt generation once; retries reuse the final reading and stable {closeKey}.
    const path = this.costPath(lane.key);
    const recorded = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as UsageSnapshot)
          .findLast(
            (entry) =>
              entry.final === true &&
              (entry.openedAt === lane.openedAt ||
                (entry.openedAt === undefined && Date.parse(entry.at) >= Date.parse(lane.openedAt))),
          )
      : undefined;
    if (recorded) return recorded;
    const snapshot = await this.usage(lane, this.deps.clock.now());
    if (this.options.recordCostArgv?.length && (snapshot.tokens !== null || snapshot.costUsd !== null)) {
      const result = await this.deps.run(
        fill(this.options.recordCostArgv, {
          key: lane.key,
          session: lane.session ?? "",
          tokens: snapshot.tokens === null ? "null" : String(snapshot.tokens),
          costUsd: snapshot.costUsd === null ? "null" : String(snapshot.costUsd),
          at: snapshot.at,
          closeKey: `${lane.key}@${lane.openedAt}`,
        }),
        { ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 },
      );
      if (result.code !== 0) {
        // Kept as a plain reading, so the next close takes a new one and runs the hook again.
        this.record(snapshot);
        throw new Error(`recordCost failed for ${lane.key}: ${result.err}`);
      }
    }
    const final: UsageSnapshot = { ...snapshot, final: true };
    this.record(final);
    return final;
  }
}
