// The progress clock: only new evidence (a file changed since the last progress, a link not reported before), a start
// or a READY moves it. A report without new evidence is delivered and logged, but the clock keeps running, so a lane
// that keeps saying "still waiting" is escalated to the lead like a silent one.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { ageText, fitEnd, fitStart, hhmm, indented, oneName } from "./fit.ts";
import type { Lane } from "./store-types.ts";

/** Minutes without progress before the duty loop tells the lead, once per stall. */
export const ESCALATE_MINUTES = 40;

const LINK_RE = /^(https?:\/\/\S+|[\w.-]+\/[\w.-]+#\d+)$/;

/** When the lane last made progress; a record from before the clock existed counts its last start, report or READY. */
export const progressOf = (lane: Lane): number =>
  lane.progressAt ??
  Math.max(
    lane.createdAt,
    ...lane.log.filter((e) => e.kind === "start" || e.kind === "report" || e.kind === "ready").map((e) => e.at),
  );

/** Why one --evidence value does not count as progress, or its file's modification time (0 for a link) when it does. */
function counted(lane: Lane, ref: string, since: number): { why: string } | { mtime: number } {
  if (LINK_RE.test(ref)) return lane.evidenceSeen?.includes(ref) ? { why: "reported before" } : { mtime: 0 };
  let mtime: number;
  try {
    const file = statSync(resolve(ref));
    if (!file.isFile()) return { why: "not a regular file" };
    mtime = file.mtimeMs;
  } catch {
    return { why: "no such file" };
  }
  if (mtime <= since) return { why: `not changed since ${hhmm(since)}` };
  // A file dated in the future stays newer than the last progress until the clock catches up, so it counts only when
  // its modification time differs from the one it counted with last time.
  return lane.evidenceMtimes?.[resolve(ref)] === mtime ? { why: "counted before, not changed since" } : { mtime };
}

/**
 * Applies a report's evidence to the lane record (the caller saves it). New evidence starts a progress epoch at `now`,
 * clearing its nudge count and escalation marker; anything else leaves them alone. Returns the CLI's PROGRESS lines.
 */
export function applyEvidence(lane: Lane, evidence: readonly string[], now: number): string[] {
  const since = progressOf(lane);
  lane.progressAt = since;
  const skipped: string[] = [];
  let moved: string | undefined;
  for (const ref of evidence) {
    const c = counted(lane, ref, since);
    if ("why" in c) {
      const full = oneName(ref);
      const shown = fitStart(full, 60);
      skipped.push(...withWhole(`  not counted: ${shown} (${c.why})`, shown, full));
      continue;
    }
    moved = ref;
    if (LINK_RE.test(ref)) lane.evidenceSeen = [...(lane.evidenceSeen ?? []), ref];
    else lane.evidenceMtimes = { ...lane.evidenceMtimes, [resolve(ref)]: c.mtime };
  }
  if (moved === undefined)
    return [
      `PROGRESS unchanged since ${hhmm(since)} (${ageText(now - since)}): no new evidence, so the nudge and escalation clock keeps running`,
      ...skipped,
    ];
  lane.progressAt = now;
  lane.progressEpoch = (lane.progressEpoch ?? 0) + 1;
  lane.nudges = 0;
  delete lane.escalatedAt;
  lane.lastEvidence = { ref: moved, at: now };
  const full = oneName(moved);
  const shown = fitStart(full, 80);
  return [...withWhole(`PROGRESS ${hhmm(now)}: ${shown}`, shown, full), ...skipped];
}

/**
 * True when this progress epoch has stalled without a queued escalation. Older binaries could retain a marker at or
 * before their latest progress; that marker belongs to an earlier epoch. New evidence and READY explicitly clear it,
 * including after clock rollback. Legacy nudge counts prove no delivery: one renewed alert establishes a marker.
 */
export const stalled = (lane: Lane, now: number): boolean => {
  const since = progressOf(lane);
  return now - since >= ESCALATE_MINUTES * 60_000 && (lane.escalatedAt === undefined || lane.escalatedAt <= since);
};

/**
 * A blocker named in report text: its first line (a CR or line separator ends one too) without a leading `WAITING:`,
 * trimmed. A name keeps the spaces inside it (`oneName`).
 */
export const blockerOf = (text: string): string =>
  oneName(text.split(/[\n\r\u2028\u2029]/)[0]!.replace(/^\s*WAITING:\s*/i, "")).trim() || "?";

/**
 * What a waiting lane waits on, on one line; a record from before `--for` names its last report's blocker. A target is
 * stored one-line, and one stored before that is made so here.
 */
export const waitingTarget = (lane: Lane): string =>
  oneName(lane.waitingFor ?? blockerOf(lane.log.findLast((e) => e.kind === "report")?.text ?? "?")).trim() || "?";

/** What a waiting lane waits on, cut to 40 columns, or to `cols` when a line leaves it fewer. */
export const waitingOn = (lane: Lane, cols = 40): string => fitEnd(waitingTarget(lane), Math.min(40, cols));

/** When the lane started waiting; a record from before `waitingSince` counts from its last progress. */
export const waitingSinceOf = (lane: Lane): number => lane.waitingSince ?? progressOf(lane);

/** `line` alone when the `shown` part of it is `full` whole, else `line` and `full` on one indented line below it. */
const withWhole = (line: string, shown: string, full: string): string[] =>
  shown === full ? [line] : [line, ...indented(full)];

/**
 * The [ESCALATE] message: how long, what the pane is doing, how often it was nudged or talked, the last evidence; for a
 * waiting lane also what it waits on. The key line is the only one that can be long (a lane key is up to 41 characters);
 * the counts get a line of their own so no cut can drop them. A target or evidence its line cut follows it whole.
 */
export function escalation(lane: Lane, pane: string, now: number): string {
  const since = progressOf(lane);
  const talk = lane.log.filter((e) => e.kind === "report" && e.at > since).length;
  const waiting = lane.status === "waiting";
  const head = `[ESCALATE ${lane.key}${waiting ? " WAITING" : ""}] no new evidence for ${ageText(now - since)} (since ${hhmm(since)})`;
  const counts = `pane ${pane}, ${lane.nudges} nudges, ${talk} reports without evidence`;
  const next = waiting ? "check it is alive, or reassign the lane" : "check the lane, re-brief it, or close it";
  const ref = lane.lastEvidence ? oneName(lane.lastEvidence.ref) : "";
  const shown = fitStart(ref, 48);
  const last = lane.lastEvidence
    ? withWhole(`last evidence: ${shown} @ ${hhmm(lane.lastEvidence.at)}. Next: ${next}.`, shown, ref)
    : [`last evidence: none recorded. Next: ${next}.`];
  if (!waiting) return [head, counts, ...last].join("\n");
  const target = waitingTarget(lane);
  const on = waitingOn(lane);
  return [head, ...withWhole(`waiting on ${on} since ${hhmm(waitingSinceOf(lane))}`, on, target), counts, ...last].join(
    "\n",
  );
}
