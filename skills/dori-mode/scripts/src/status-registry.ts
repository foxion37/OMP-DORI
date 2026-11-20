import { type Lane, LANE_KEY, type LaneStatus, type Registry } from "./registry.ts";

const STATUSES: Readonly<Record<LaneStatus, true>> = {
  working: true,
  paused: true,
  "done-claimed": true,
  "verified-done": true,
  "not-done": true,
  closed: true,
};

export const isStoredLaneStatus = (status: unknown): boolean =>
  status === undefined || (typeof status === "string" && Object.hasOwn(STATUSES, status));

/** scan isolates unreadable files; these are the fields consumed by the status and ETA projections. */
const readable = (lane: Lane): boolean => {
  if (typeof lane !== "object" || lane === null || Array.isArray(lane)) return false;
  for (const field of ["key", "title", "thread", "openedAt", "brief", "done"] as const)
    if (typeof lane[field] !== "string") return false;
  const opened = Date.parse(lane.openedAt);
  if (!LANE_KEY.test(lane.key) || !Number.isFinite(opened)) return false;
  for (const field of ["closedAt", "cwd", "pane", "tab", "session", "lastFreshnessNote"] as const)
    if (lane[field] !== undefined && typeof lane[field] !== "string") return false;
  if (lane.closedAt !== undefined) {
    const closed = Date.parse(lane.closedAt);
    if (!Number.isFinite(closed) || closed < opened) return false;
  }
  for (const field of ["lastNudgeAt", "lastAutoReplyAt"] as const)
    if (lane[field] !== undefined && (typeof lane[field] !== "number" || !Number.isFinite(lane[field]))) return false;
  if (!isStoredLaneStatus(lane.status)) return false;
  const ref = lane.sessionRef;
  return (
    ref === undefined ||
    (typeof ref === "object" &&
      ref !== null &&
      !Array.isArray(ref) &&
      (ref.runtime === "herdr" || ref.runtime === "hc") &&
      typeof ref.id === "string" &&
      ref.id.length > 0 &&
      (ref.container === undefined || typeof ref.container === "string"))
  );
};

export const readStatusRegistry = async (registry: Registry, key?: string) => {
  const errors: string[] = [];
  let candidates: Lane[] = [];
  try {
    if (key === undefined) {
      const scanned = await registry.scan();
      candidates = scanned.lanes;
      if (scanned.unreadable.length)
        errors.push(`registry incomplete: ${scanned.unreadable.length} unreadable record(s)`);
    } else {
      const lane = await registry.read(key);
      if (lane !== null) candidates = [lane];
    }
  } catch {
    errors.push("registry unreadable");
  }
  const lanes = candidates.filter((lane) => {
    if (readable(lane) && (key === undefined || lane.key === key)) return true;
    errors.push("registry record has invalid status fields");
    return false;
  });
  return { lanes, errors };
};
