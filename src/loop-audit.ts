// The hourly loop's audit pass: open lanes whose session is gone, READY lanes left open, lanes without progress for hours.
import type { Deps } from "./harness.ts";
import { progressOf, waitingSinceOf, waitingTarget } from "./progress.ts";
import { hhmm } from "./fit.ts";
import { refText } from "./refs.ts";
import type { AgentStatus } from "./runtime/types.ts";
import type { LoopRun } from "./store-types.ts";

export const HOUR = 3_600_000;
const STALE_HOURS = 3;
const READY_HOURS = 2;

const hours = (ms: number): number => Math.floor(ms / HOUR);

export async function audit(d: Deps, run: LoopRun): Promise<void> {
  const now = d.now();
  for (const lane of d.store.lanes()) {
    if (lane.status !== "working" && lane.status !== "waiting" && lane.status !== "ready") continue;
    let st: AgentStatus;
    try {
      st = (await d.runtimes.for(lane.sessionRef).probe(lane.sessionRef)).status;
    } catch (e) {
      run.findings.push(`${lane.sessionRef.runtime}: ${lane.key}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (st === "gone") {
      run.findings.push(`${lane.key} pane ${refText(lane.sessionRef)} is gone`);
    } else if (lane.status === "ready") {
      const age = now - (lane.final?.at ?? lane.lastActivityAt);
      if (age >= READY_HOURS * HOUR)
        run.findings.push(`${lane.key} READY ${hours(age)}h ago, not closed: dori harness done ${lane.key}`);
    } else if (now - progressOf(lane) >= STALE_HOURS * HOUR) {
      // Progress, not talk: a lane that keeps reporting without new evidence is as stale as a silent one.
      const age = hours(now - progressOf(lane));
      // A waiting lane's last entry is as often the duty loop's escalation as its own report: name what it waits on,
      // whole, since a cut link or job id names nothing the lead can check.
      run.findings.push(
        lane.status === "waiting"
          ? `${lane.key} waiting, no progress for ${age}h: on ${waitingTarget(lane)} since ${hhmm(waitingSinceOf(lane))}`
          : `${lane.key} working, no progress for ${age}h`,
      );
    }
  }
}
