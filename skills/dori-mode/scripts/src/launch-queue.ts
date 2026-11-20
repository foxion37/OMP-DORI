import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { queueDefaultCwd } from "./config.ts";
import { withLaunchLock } from "./delivery-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { sampleHost, type HostSample } from "./host-guard.ts";
import { LaunchQueue, type QueueEntry } from "./launch-queue-store.ts";
import { QueueError } from "./launch-errors.ts";
import { openLaunch, prepareLaunch } from "./launch.ts";
import type { LaunchInput } from "./launch-input.ts";
import { LANE_KEY, type Lane, sameLaneGeneration, statusOf } from "./registry.ts";
import { canLaunch } from "./routing.ts";
import { iso, runtimesOf } from "./run.ts";
import { checkDone } from "./signals.ts";

type Sample = (cwd: string) => Promise<HostSample>;
const sampler =
  (deps: FlowDeps): Sample =>
  (cwd) =>
    sampleHost(deps.run, cwd, runtimesOf(deps));

const expiryReason = "expired; cancel and requeue after reviewing the brief";
const expired = (deps: FlowDeps, entry: QueueEntry): boolean => Date.parse(entry.expiresAt) <= deps.clock.now();
const successfulReceipt = (receipt: unknown): boolean =>
  !!receipt &&
  typeof receipt === "object" &&
  (!("outcome" in receipt) || receipt.outcome === "done") &&
  "checks" in receipt &&
  Array.isArray(receipt.checks) &&
  receipt.checks.length > 0 &&
  receipt.checks.every((check: unknown) => !!check && typeof check === "object" && "ok" in check && check.ok === true);

const prerequisites = async (deps: FlowDeps, entry: QueueEntry, live = false) => {
  const predecessors: Lane[] = [];
  if (expired(deps, entry)) return { predecessors, reasons: [expiryReason] };
  const reasons: string[] = [];
  for (const key of entry.after) {
    const lane = await deps.registry.read(key).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      throw new QueueError(`unreadable predecessor record: ${key}`);
    });
    if (lane !== null && (lane.key !== key || typeof lane.done !== "string"))
      throw new QueueError(`invalid predecessor record: ${key}`);
    const receipt = lane?.receipt;
    if (!lane || statusOf(lane) !== "closed") {
      reasons.push(`${key}(${lane ? statusOf(lane) : "not registered"})`);
      continue;
    }
    if (!successfulReceipt(receipt)) {
      reasons.push(`${key}(no successful completion receipt)`);
      continue;
    }
    predecessors.push(lane);
    if (live) {
      const checks = await checkDone(lane.done, deps.run, {
        cwd: lane.cwd ?? deps.config.defaultCwd,
        ...deps.signalIo,
      });
      if (checks.some((check) => !check.ok)) reasons.push(`${key}(Done no longer live)`);
    }
  }
  if (expired(deps, entry)) reasons.push(expiryReason);
  return { predecessors, reasons };
};

export const enqueueLaunch = async (
  deps: FlowDeps,
  input: LaunchInput,
  after: readonly string[],
  expiresHours = 24,
): Promise<QueueEntry> => {
  new LaunchQueue(deps.config.stateDir).path(input.key);
  if (!after.length || after.some((key) => !LANE_KEY.test(key) || key === input.key))
    throw new QueueError("--after needs distinct predecessor lane keys, excluding this key");
  const expiresAt = new Date(deps.clock.now() + expiresHours * 3_600_000);
  if (!Number.isFinite(expiresHours) || expiresHours <= 0 || !Number.isFinite(expiresAt.getTime()))
    throw new QueueError("--expires-hours must be positive and produce a valid expiry date");
  const graph = await withLaunchLock(deps, ".queue-graph", () =>
    withLaunchLock(deps, input.key, async () => {
      const queue = new LaunchQueue(deps.config.stateDir);
      const prior = queue.read(input.key);
      if (prior && prior.status !== "cancelled") throw new QueueError(`queue ${input.key} already exists`);
      const reaches = (key: string, visited = new Set<string>()): boolean => {
        if (key === input.key) return true;
        if (visited.has(key)) return false;
        visited.add(key);
        return queue.read(key)?.after.some((parent) => reaches(parent, visited)) ?? false;
      };
      for (const key of after) {
        if (!(await deps.registry.read(key)) && !queue.read(key))
          throw new QueueError(`unknown predecessor lane: ${key}`);
        if (reaches(key)) throw new QueueError(`queue dependency cycle through ${key}`);
      }
      const requestedCwd = input.cwd ?? queueDefaultCwd(deps.config);
      let cwd: string;
      try {
        // The OS must follow symlinks before applying any later `..` components.
        cwd = realpathSync.native(isAbsolute(requestedCwd) ? requestedCwd : `${process.cwd()}${sep}${requestedCwd}`);
        if (!statSync(cwd).isDirectory()) throw new QueueError("not a directory");
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new QueueError(`queue cwd must be an existing directory: ${JSON.stringify(requestedCwd)}`);
      }
      const prepared = await prepareLaunch(deps, { ...input, cwd });
      const { template: _template, variables: _variables, ...plain } = input;
      const entry: QueueEntry = {
        id: randomUUID(),
        input: { ...plain, cwd },
        briefText: prepared.briefText,
        after: [...new Set(after)],
        queuedAt: iso(deps.clock),
        expiresAt: expiresAt.toISOString(),
        status: "pending",
      };
      queue.write(entry);
      return entry;
    }),
  );
  if (!graph.ok) throw new QueueError(`queue graph held: ${graph.holder}`);
  const held = graph.value;
  if (!held.ok) throw new QueueError(`queue ${input.key} held: ${held.holder}`);
  return held.value;
};

export const startQueued = async (
  deps: FlowDeps,
  key: string,
  sample = sampler(deps),
): Promise<{ code: number; lines: string[] }> => {
  new LaunchQueue(deps.config.stateDir).path(key);
  const held = await withLaunchLock(deps, key, async () => {
    const queue = new LaunchQueue(deps.config.stateDir);
    const entry = queue.read(key);
    if (!entry || entry.status !== "pending")
      throw new QueueError(`queue ${key} is ${entry?.status ?? "absent"}; no launch retried`);
    if (await deps.registry.read(key))
      throw new QueueError(`lane ${key} is already registered; inspect the queue receipt`);
    const queueHeld = (reasons: readonly string[]) => ({
      code: 4,
      lines: [`QUEUE_HELD ${key} ${reasons.join(" | ")}`],
    });
    const { predecessors, reasons } = await prerequisites(deps, entry, true);
    if (reasons.length) return queueHeld(reasons);
    // Older reservations without a cwd retain the start-time default.
    const cwd = entry.input.cwd ?? deps.config.defaultCwd;

    // Different keys share the same pane budget. Hold admission through creation, not agent startup.
    const admission = await withLaunchLock(deps, ".queue-capacity", async () => {
      if (expired(deps, entry)) return { kind: "held", reasons: [expiryReason] } as const;
      const host = canLaunch(await sample(cwd), deps.config.guard);
      const latest = await Promise.all(predecessors.map((lane) => deps.registry.read(lane.key)));
      const reasons = [...host.reasons];
      for (const [index, seen] of predecessors.entries()) {
        const current = latest[index];
        if (
          !current ||
          !sameLaneGeneration(seen, current) ||
          !successfulReceipt(current.receipt) ||
          !isDeepStrictEqual(seen.receipt, current.receipt)
        )
          reasons.push(`${seen.key}(predecessor changed during checks)`);
      }
      if (expired(deps, entry)) reasons.push(expiryReason);
      if (reasons.length) return { kind: "held", reasons } as const;

      // Durable intent precedes terminal creation. A crash cannot silently launch the job twice.
      const starting: QueueEntry = { ...entry, status: "starting" };
      queue.write(starting);
      const brief = resolve(deps.config.stateDir, "queued-briefs", `${entry.id}.md`);
      const opened = await openLaunch(deps, { ...entry.input, cwd, brief, queueId: entry.id }, entry.briefText);
      return { kind: "opened", starting, opened } as const;
    });
    if (!admission.ok) return queueHeld([`host admission lock: ${admission.holder}`]);
    if (admission.value.kind === "held") return queueHeld(admission.value.reasons);

    const { starting, opened } = admission.value;
    const launched = await opened.start();
    queue.write({ ...starting, status: "started" });
    return {
      code: /^STARTUP_(OK|DONE)/.test(launched.startup) ? 0 : 3,
      lines: [...opened.warnings, `QUEUE_STARTED ${key} pane=${launched.lane.pane}`, launched.startup],
    };
  });
  if (!held.ok) throw new QueueError(`queue ${key} held: ${held.holder}`);
  return held.value;
};

export const cancelQueued = async (deps: FlowDeps, key: string): Promise<string> => {
  new LaunchQueue(deps.config.stateDir).path(key);
  const held = await withLaunchLock(deps, key, async () => {
    const queue = new LaunchQueue(deps.config.stateDir);
    const entry = queue.read(key);
    if (!entry) throw new QueueError(`queue ${key} is absent`);
    if (entry.status === "started" || (await deps.registry.read(key)))
      throw new QueueError(`lane ${key} is registered; cancelling a queue never stops an agent`);
    queue.write({ ...entry, status: "cancelled" });
    return `QUEUE_CANCELLED ${key}; no pane or worktree removed`;
  });
  if (!held.ok) throw new QueueError(`queue ${key} held: ${held.holder}`);
  return held.value;
};

/** Notification only. Even a ready entry requires the operator's explicit queue start. */
export const queueTick = async (deps: FlowDeps): Promise<string[]> => {
  const queue = new LaunchQueue(deps.config.stateDir);
  const scan = queue.scan();
  const lines = scan.problems.map((problem) => `LANE_QUEUE_WARN ${problem}`);
  for (const listed of scan.entries.filter((entry) => entry.status === "pending")) {
    // Live checks can hold this lock for seconds while the reservation still reads pending.
    const held = await withLaunchLock(
      deps,
      listed.input.key,
      async () => {
        const entry = queue.read(listed.input.key);
        if (!entry || entry.status !== "pending") return;
        let notice: string;
        try {
          const { reasons } = await prerequisites(deps, entry);
          notice = reasons.length
            ? `LANE_QUEUE_HELD ${entry.input.key} ${reasons.join(" | ")}`
            : `LANE_QUEUE_READY ${entry.input.key}; live checks run on explicit dori queue start ${entry.input.key}`;
        } catch (error) {
          if (!(error instanceof QueueError)) throw error;
          notice = `LANE_QUEUE_WARN ${entry.input.key} ${error.message}`;
        }
        if (notice === entry.lastNotice) return;
        queue.write({ ...entry, lastNotice: notice });
        lines.push(notice);
      },
      0,
    );
    if (!held.ok) lines.push(`LANE_QUEUE_HELD ${listed.input.key} lock: ${held.holder}`);
  }
  return lines;
};
