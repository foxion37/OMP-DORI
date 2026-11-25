import { createHash } from "node:crypto";
import { fill } from "./config.ts";
import { type Held, withDeliveryLock } from "./delivery-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type Lane, LANE_KEY, statusOf, withStatus } from "./registry.ts";
import { iso } from "./run.ts";
import { isStoredLaneStatus } from "./status-registry.ts";

type GroupClose<T> = {
  readonly result: T;
  readonly remaining?: readonly string[];
};

export class ThreadElectionError extends Error {
  override readonly name = "ThreadElectionError";
}

// Launch and adopt record a lane without a thread as the explicit "none" sentinel.
const ungrouped = (thread: string): boolean => thread === "none";

const grouped = (deps: FlowDeps, lane: Lane): boolean =>
  deps.config.threadDonePolicy === "last-lane" && !ungrouped(lane.thread);

/** Existing members enter with their lane delivery lock held; never acquire one from here. */
export const withThreadLock = async <T>(
  deps: FlowDeps,
  lane: Lane,
  change: () => Promise<T>,
  waitMs?: number,
): Promise<Held<T>> => {
  if (!grouped(deps, lane)) return { ok: true, value: await change() };
  if (typeof lane.thread !== "string") throw new ThreadElectionError(`invalid thread for lane ${lane.key}`);
  // @ cannot begin a lane key, so this cannot collide with a lane's own delivery lock.
  const key = `@thread-${createHash("sha256").update(lane.thread).digest("hex")}`;
  return withDeliveryLock(deps, key, change, waitMs);
};

const members = async ({ registry }: FlowDeps, lane: Lane): Promise<Lane[]> => {
  const { lanes, unreadable } = await registry.scan(true).catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    throw new ThreadElectionError(`thread membership scan failed: ${error.message}`, { cause: error });
  });
  if (unreadable.length) throw new ThreadElectionError(`thread membership unreadable: ${unreadable.join(", ")}`);
  for (const entry of lanes) {
    if (
      !LANE_KEY.test(entry.key) ||
      typeof entry.thread !== "string" ||
      typeof entry.openedAt !== "string" ||
      !Number.isFinite(Date.parse(entry.openedAt)) ||
      !isStoredLaneStatus(entry.status) ||
      (entry.closedAt !== undefined &&
        (typeof entry.closedAt !== "string" || !Number.isFinite(Date.parse(entry.closedAt))))
    )
      throw new ThreadElectionError(`invalid thread membership: ${entry.key}`);
  }
  if (!lanes.some((entry) => entry.key === lane.key && entry.thread === lane.thread))
    throw new ThreadElectionError(`thread membership changed for lane ${lane.key}`);
  return lanes.filter((entry) => entry.thread === lane.thread);
};

/** Verify inside the acquired lock; only a contended attempt needs a separate preflight for the held branch. */
export const withThreadClose = async <T>(
  deps: FlowDeps,
  lane: Lane,
  preflight: (groupLocked: boolean) => Promise<boolean>,
  close: () => Promise<T>,
): Promise<Held<GroupClose<T> | undefined>> => {
  const inGroup = grouped(deps, lane);
  const attempt = (waitMs?: number) =>
    withThreadLock(
      deps,
      lane,
      async (): Promise<GroupClose<T> | undefined> => {
        if (!(await preflight(inGroup))) return undefined;
        if (!inGroup) return { result: await close() };
        const remaining = (await members(deps, lane))
          .filter((other) => other.key !== lane.key && statusOf(other) !== "closed")
          .map((other) => other.key);
        return { result: await close(), remaining };
      },
      waitMs,
    );
  const immediate = await attempt(0);
  if (immediate.ok) return immediate;
  if (!(await preflight(false))) return { ok: true, value: undefined };
  return attempt();
};

export const recordThreadHold = async (deps: FlowDeps, lane: Lane): Promise<boolean> => {
  // An already-prepared native close retains its saved decision and evidence.
  if (lane.nativeCloseIntent || statusOf(lane) !== "done-claimed") return true;
  await members(deps, lane);
  return (
    (await deps.registry.transition(lane, (current) =>
      withStatus(current, "verified-done", "Done signals read back live", iso(deps.clock), {
        threadClosePending: true,
      }),
    )) !== null
  );
};

export const finishThread = async (
  deps: FlowDeps,
  lane: Lane,
  note: string,
  remaining?: readonly string[],
): Promise<string[]> => {
  if (ungrouped(lane.thread)) return [];
  if (remaining?.length)
    return [
      `thread ${lane.thread}: ${remaining.length} lanes still open (${remaining.join(", ")}); threadDone skipped`,
    ];
  const hook = deps.config.hooks.threadDone;
  if (!hook) return [];
  const result = await deps.run(fill(hook, { thread: lane.thread, text: note, key: lane.key }));
  return [result.code === 0 ? "thread marked done" : `thread hook failed: ${result.err.slice(0, 160)}`];
};
