export const parseCatalyRole = (value: unknown): "cataly" | "lane" | undefined =>
  value === "cataly" || value === "lane" ? value : undefined;

export const isCatalyEntry = (value: unknown, current: `omp-cataly:${string}`): boolean => value === current;

export const SESSION_WIRE = {
  role: "omp-cataly:role",
  monitor: "omp-cataly:monitor",
  intake: "omp-cataly:intake",
  monitorBootstrap: "omp-cataly:monitor-bootstrap",
  lanePolicy: "omp-cataly:lane-policy",
  laneReceiver: "omp-cataly:discord-lane-receiver",
  askLane: "omp-cataly:discord-ask-lane",
  remoteOwner: "omp-cataly:native-remote-owner",
  admissionRejected: "omp-cataly:admission-rejected",
  monitorMessage: "cataly-monitor",
} as const;

export const MONITOR_MESSAGE = SESSION_WIRE.monitorMessage;
export const isMonitorMessage = (value: unknown): boolean => value === MONITOR_MESSAGE;

/**
 * The previous main's kind for the same monitor message: lane input, monitor notices and head-admission receipts.
 * Those transcripts are live data, so the readers that identify such a message accept both kinds; only
 * {@link MONITOR_MESSAGE} is ever written.
 */
export const PREVIOUS_MONITOR_MESSAGE = "dori-monitor";

type RecordedEntry = { readonly type: string; readonly customType?: string; readonly data?: unknown };

/** The newest recorded role that parses; an unrecognized value leaves the previous one in place. */
export const recordedRole = (branch: readonly RecordedEntry[]): "cataly" | "lane" | undefined => {
  let role: "cataly" | "lane" | undefined;
  for (const entry of branch)
    if (entry.type === "custom" && isCatalyEntry(entry.customType, SESSION_WIRE.role))
      role = parseCatalyRole(entry.data) ?? role;
  return role;
};
