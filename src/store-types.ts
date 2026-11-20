import type { SessionRef } from "./runtime/types.ts";

export type LaneStatus = "working" | "waiting" | "ready" | "done" | "lost";

/**
 * One lane record. `sessionRef` is the session it runs in, on whichever runtime opened it; `paneId`/`tabId` are written
 * beside it (the ref's id and container) so an older binary still reads the file. `migratedFrom`: the sessions it ran in
 * before a `dori migrate`. `migration`: a handover is in progress, and the duty loop leaves the record alone.
 * `sessionPath`: the agent's own session file, when its command records one; `dori migrate --resume` needs it.
 * `progressAt`: the last time the lane made progress (start, a report with new evidence, READY); the duty loop nudges and
 * escalates on it, and a record from before it existed falls back to its last start, report or READY. `lastEvidence`:
 * the evidence that last moved it. `evidenceSeen`: links that already counted once. `evidenceMtimes`: each file that
 * counted, by absolute path, with the modification time it counted with. `escalatedAt`: when the lead was last told the
 * lane made no progress; one escalation per stall. `lastActivityAt`: the last sign of life (any report, a working pane).
 * `waitingFor`/`waitingSince`: what a waiting lane said it waits on (`report --status waiting --for`) and when it started
 * waiting; a waiting lane runs on the same clock, and its nudges and escalation name them.
 * `noticeId`: this lane incarnation's persisted random identity. `progressEpoch`: its counter, advanced by new evidence
 * and READY independently of wall time, so notice retries reuse an id and a new epoch or reused lane key gets a new one.
 * `priority`: 1 (first) to 9 (last), from `start --priority`, the backlog item or `priority`; a lock waits in line by it.
 */
export type Lane = {
  key: string;
  sessionRef: SessionRef;
  migratedFrom?: SessionRef[];
  migration?: true;
  sessionPath?: string;
  paneId: string;
  tabId: string;
  brief: string;
  cwd: string;
  status: LaneStatus;
  createdAt: number;
  lastActivityAt: number;
  progressAt?: number;
  noticeId?: string;
  progressEpoch?: number;
  lastEvidence?: { ref: string; at: number };
  evidenceSeen?: string[];
  evidenceMtimes?: Record<string, number>;
  escalatedAt?: number;
  waitingFor?: string;
  waitingSince?: number;
  priority?: number;
  nudges: number;
  final?: { text: string; evidence: string[]; at: number };
  log: { at: number; kind: "start" | "report" | "ready" | "nudge" | "escalate" | "done" | "lost"; text: string }[];
};

/** The sessions `dori up` opens; roles.json maps each to a ref string (a bare herdr pane id, or `hc:t7`). */
export type Role = "lead" | "duty" | "duty-loop" | "hourly-loop";

/**
 * A delivery that failed after the message may have reached the pane (#89). `typed`: the text is in the pane's input
 * and only Enter is retried; `agent` and `pgid` identify the input (#108); OMP also records its `pid` and `sessionId`.
 * `ambiguous`: it may or may not have arrived; it is held, never resent automatically.
 */
export type DeliveryAttempt = {
  at: number;
  state: "typed" | "ambiguous";
  detail?: string;
  agent?: string;
  pgid?: number;
  pid?: number;
  sessionId?: string;
};

/** A flush lock from another host (or an unreadable one) older than this is taken over; on this host only a dead pid frees it (#108). */
export const INBOX_LOCK_STALE_MS = 60_000;

/**
 * `id`: a duty notice's fixed incarnation/epoch name; one id is queued for a session only once. `spool`: the name of
 * the spool file the message came through (inbox-spool.ts), so it stays one message however its move was cut short.
 */
export type QueuedMessage = {
  at: number;
  from: string;
  text: string;
  id?: string;
  spool?: string;
  attempt?: DeliveryAttempt;
};

export type ReviewReceipt = {
  pr: string;
  sha: string;
  verdict: "CLEAR" | "BLOCK";
  model: string;
  at: number;
  summary: string;
};

export type ItemStatus = "open" | "running" | "done" | "dropped";

/** One backlog entry. Its id is the lane key the hourly loop starts it under. */
export type Item = {
  id: string;
  title: string;
  brief: string;
  cwd: string;
  priority: number;
  status: ItemStatus;
  decision?: string;
  askedAt?: number;
  remindedAt?: number;
  attempts: number;
  startFailures?: number;
  source?: string;
  createdAt: number;
  updatedAt: number;
  log: { at: number; kind: "add" | "start" | "reopen" | "done" | "drop" | "ask" | "remind" | "decide"; text: string }[];
};

export type HostLoad = { load1: number; cores: number; memFreePct: number };

export type LoopRun = {
  at: number;
  skipped?: string;
  status?: {
    lanes: number;
    maxLanes: number;
    adhoc: string[];
    items: { open: number; decide: number; running: number };
    host: HostLoad;
  };
  synced: string[];
  findings: string[];
  started: string[];
  held: string[];
  asked: string[];
};

export const KEEP_RUNS = 168;
export const KEY_RE = /^[a-z][a-z0-9-]{1,40}$/;
/** Role names are send targets, and resolveTarget tries roles first, so a lane with one of these keys could never be reached. */
export const RESERVED_KEYS: readonly Role[] = ["lead", "duty", "duty-loop", "hourly-loop"];
/** Refusal text for a reserved lane key, or undefined. Keys are lowercase-only (KEY_RE), so the exact match is the whole check. */
export const reservedKey = (key: string): string | undefined =>
  (RESERVED_KEYS as readonly string[]).includes(key) ? `lane key "${key}" is reserved for the ${key} role` : undefined;
