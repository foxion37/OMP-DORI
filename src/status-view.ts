// The lane board `dori status` prints: open lanes first, the longest without progress on top, closed lanes folded into
// one line each, every line within WIDTH terminal columns except a key, ref, link or id wider than that, kept whole.
import { ageText, fitEnd, hhmm, indented, oneLine, padCols, WIDTH, wrap } from "./fit.ts";
import { progressOf, waitingOn, waitingSinceOf, waitingTarget } from "./progress.ts";
import { refText } from "./refs.ts";
import type { Lane } from "./store-types.ts";

/** Columns the progress field and the start of the last entry need beside a lane's name; fewer moves them below it. */
const BODY_MIN = 40;

/** A waiting lane's minimum beside its name: the progress field, then `waiting: <1 col>… since HH:MM` whole. */
const WAITING_MIN = 24 + Bun.stringWidth("waiting: x… since 00:00");

/**
 * `<last entry>` for a working lane; a waiting lane's `waiting: <target> since HH:MM | <last entry>`, the target cut
 * first so the time always shows, the last entry given what is left of `cols`.
 */
function tailOf(l: Lane, cols: number): string {
  const last = l.log.at(-1);
  const tail = last ? `${last.kind} ${hhmm(last.at)}: ${oneLine(last.text)}` : "";
  if (l.status !== "waiting") return tail;
  const until = ` since ${hhmm(waitingSinceOf(l))}`;
  const waiting = `waiting: ${fitEnd(waitingOn(l), cols - Bun.stringWidth(`waiting: ${until}`))}${until}`;
  const room = cols - Bun.stringWidth(waiting) - 3;
  return room > 1 && tail ? `${waiting} | ${fitEnd(tail, room)}` : waiting;
}

/**
 * `key  status  runtime  ref  progress <age> (<since>)  <tail>`. The key and the ref are never cut (keys share
 * prefixes, and a cut one names no lane a command can take): their columns are as wide as the widest open lane's, and
 * the rest is cut to the line. When they leave less than BODY_MIN columns (WAITING_MIN for a waiting lane, so its
 * target and time are never cut off the line's end), the rest goes on an indented line below. A waiting target the line
 * cut follows whole on one indented line: a cut link or job id names nothing to check.
 */
function laneLine(l: Lane, now: number, cols: { key: number; ref: number }): string[] {
  const since = progressOf(l);
  const id = [
    padCols(l.key, cols.key),
    padCols(l.status, 8),
    padCols(l.sessionRef.runtime, 5),
    padCols(refText(l.sessionRef), cols.ref),
  ].join(" ");
  const progress = padCols(`progress ${ageText(now - since)} (${hhmm(since)})`, 23);
  const body = (room: number) => fitEnd(`${progress} ${tailOf(l, room - 24)}`.trimEnd(), room);
  const room = WIDTH - Bun.stringWidth(id) - 1;
  const lines =
    room >= (l.status === "waiting" ? Math.max(BODY_MIN, WAITING_MIN) : BODY_MIN)
      ? [`${id} ${body(room)}`]
      : [...wrap(id.trimEnd(), WIDTH), `  ${body(WIDTH - 2)}`];
  if (l.status !== "waiting") return lines;
  const target = waitingTarget(l);
  return lines.some((line) => line.includes(`waiting: ${target} since `)) ? lines : [...lines, ...indented(target)];
}

/** One summary line per closed status: how many, and the one closed last. */
function closedLine(status: string, lanes: readonly Lane[], now: number): string {
  const latest = lanes.reduce((a, b) => ((b.log.at(-1)?.at ?? 0) > (a.log.at(-1)?.at ?? 0) ? b : a));
  const at = latest.log.at(-1)?.at ?? latest.lastActivityAt;
  return fitEnd(`${status} ${lanes.length} (latest ${latest.key}, ${ageText(now - at)} ago)`, WIDTH);
}

export function laneBoard(lanes: readonly Lane[], now: number): string[] {
  const open = lanes
    .filter((l) => l.status === "working" || l.status === "waiting" || l.status === "ready")
    .sort((a, b) => progressOf(a) - progressOf(b));
  const widest = (cols: (l: Lane) => string) => Math.max(0, ...open.map((l) => Bun.stringWidth(cols(l))));
  const cols = { key: widest((l) => l.key), ref: widest((l) => refText(l.sessionRef)) };
  const lines = open.flatMap((l) => laneLine(l, now, cols));
  for (const status of ["lost", "done"]) {
    const closed = lanes.filter((l) => l.status === status);
    if (closed.length) lines.push(closedLine(status, closed, now));
  }
  return lines;
}
