import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DeliveryUncertain, failureDetail } from "./delivery.ts";
import { type Deps, fill, promptFile } from "./harness.ts";
import { runHook } from "./hooks.ts";
import { flushInbox } from "./inbox.ts";
import { oweLead, payLead } from "./inbox-files.ts";
import { Refusal } from "./refusal.ts";
import { refText } from "./refs.ts";
import { escalation, progressOf, stalled, waitingOn, waitingSinceOf, waitingTarget } from "./progress.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { Lane } from "./store-types.ts";
import { ageText, hhmm, indented, WIDTH } from "./fit.ts";

/** Quiet minutes before the first and second nudge; the lead is told at ESCALATE_MINUTES without progress. */
export const NUDGE_MINUTES = [10, 20] as const;

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };

/** An open lane the duty loop watches; a lane being migrated is left alone (no nudge, no lost, no activity stamp). */
const watched = (lane: Lane): boolean =>
  (lane.status === "working" || lane.status === "waiting") && lane.migration !== true;

/** Persist a legacy lane's incarnation before queueing; retries must reuse its identity and progress epoch. */
function noticeId(d: Deps, lane: Lane): string {
  if (lane.noticeId === undefined) {
    lane.noticeId = randomUUID();
    lane.progressEpoch ??= 0;
    d.store.saveLane(lane);
  }
  return lane.noticeId;
}

/**
 * Runs `write` on the inbox of `ref` (the one it was forwarded to, if it was) under that inbox's lock, the lock every
 * rewrite of the queue holds: a flush that read the queue before an unlocked append writes it back without the
 * appended entry. False while another process holds the lock: nothing is written, and the next pass tries again.
 */
function underInboxLock(d: Deps, ref: SessionRef, write: (inbox: SessionRef) => void): boolean {
  const inbox = d.store.forwardOf(ref) ?? ref;
  const release = d.store.lockInbox(inbox, d.now());
  if (!release) return false;
  try {
    write(inbox);
    return true;
  } finally {
    release();
  }
}

const busy = (lane: Lane, whose: string): DutyEvent => ({
  lane: lane.key,
  action: "notice-deferred",
  detail: `${whose} inbox is being flushed; tried again on the next pass`,
});

/**
 * Queues the LOST notice for the lead under a fixed id. With no lead registered, or while a flush holds the lead's
 * inbox, it waits in a queue of its own (`oweLead`), not in the lane record: the same key may be started again,
 * replacing that record, before the notice is moved. Returns whether it reached the lead's inbox.
 */
function queueLost(d: Deps, lane: Lane, now: number, leadRef: SessionRef | undefined): boolean {
  const text = `[LOST ${lane.key}] pane ${refText(lane.sessionRef)} closed without a final answer`;
  const msg = { at: now, from: "duty", text, id: `lost:${lane.key}:${noticeId(d, lane)}` };
  if (leadRef && underInboxLock(d, leadRef, (inbox) => d.store.enqueueOnce(inbox, msg))) return true;
  oweLead(d.store.root, msg);
  return false;
}

/** Once a lead is registered, the notices kept for it move into its inbox, under its lock (else on a later pass). */
function payOwed(d: Deps): void {
  const lead = d.store.roles().lead;
  if (lead) underInboxLock(d, lead, (inbox) => payLead(d.store.root, d.store.inboxPath(inbox)));
}

/** One proactive pass: flush inboxes of panes that became idle, nudge silent lanes, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  // Kill switch: a stopped duty loop delivers, nudges and escalates nothing. Queued messages wait for the resume.
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  payOwed(d);
  for (const ref of d.store.inboxPanes()) {
    const paneId = refText(ref);
    try {
      const result = await flushInbox(d, ref);
      // flushInbox follows a `.forward` marker; the counts are read where the entries live now.
      const at = d.store.forwardOf(ref) ?? ref;
      if (result === "delivered") events.push({ pane: paneId, action: "flushed" });
      if (result === "no-agent") {
        events.push({
          pane: paneId,
          action: "inbox-held",
          detail: `no agent in front; ${d.store.queued(at).length} message(s) kept`,
        });
      }
      // Held after an ambiguous delivery (#89): shown on every pass, resent never; the lead was told once.
      const held = d.store.queued(at).filter((m) => m.attempt?.state === "ambiguous").length;
      if (held > 0)
        events.push({ pane: paneId, action: "delivery-ambiguous", detail: `${held} message(s) held, not resent` });
    } catch (e) {
      // One pane's failed delivery must never kill the loop for every other pane and lane.
      if (e instanceof Refusal) events.push({ pane: paneId, action: "inbox-target-gone" });
      else if (e instanceof DeliveryUncertain && !e.typed)
        events.push({ pane: paneId, action: "delivery-ambiguous", detail: failureDetail(e) });
      else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const listed of d.store.lanes()) {
    if (!watched(listed)) continue;
    try {
      const { status: st } = await d.runtimes.for(listed.sessionRef).probe(listed.sessionRef);
      // Re-read right before deciding and saving: a report, a READY or a migration may have landed during the probe.
      const lane = d.store.lane(listed.key);
      if (lane === undefined || !watched(lane) || lane.sessionRef.id !== listed.sessionRef.id) continue;
      const now = d.now();
      if (st === "gone") {
        // Marked lost and its hook run whether or not a lead is registered: a lost lane must stop counting as open. The
        // notice is queued first, under a fixed id, so a pass cut short before the lane is saved repeats it without a
        // second notice.
        const leadRef = d.store.roles().lead;
        const queued = queueLost(d, lane, now, leadRef);
        lane.status = "lost";
        lane.log.push({ at: now, kind: "lost", text: "pane disappeared without READY" });
        d.store.saveLane(lane);
        void runHook(d, "onLost", { key: lane.key, text: "pane disappeared without READY", evidence: "" });
        events.push({ lane: lane.key, action: "lost" });
        if (leadRef && queued) await flushInbox(d, leadRef);
        else if (leadRef) events.push(busy(lane, "the lead's"));
        else events.push({ lane: lane.key, action: "lost-no-lead", detail: "no lead registered; told once one is" });
        continue;
      }
      if (st === "working") {
        lane.lastActivityAt = now;
        d.store.saveLane(lane);
      }
      // The lead hears of a stall whatever the pane is doing: a lane can be busy, blocked, chatty or waiting without
      // progress. A waiting lane is not exempt: the thing it waits on can be dead.
      if (stalled(lane, now)) {
        // The stall counts as told once the message is in the lead's inbox: from there the inbox delivers it whatever
        // this flush does. It is queued under the stall's id before the lane is marked, so a pass cut short in between
        // marks it next time without a second message. With no lead registered nothing is queued or marked.
        const leadRef = d.store.roles().lead;
        if (!leadRef) {
          events.push({ lane: lane.key, action: "escalate-no-lead", detail: "no lead registered; told once one is" });
          continue;
        }
        const msg = escalation(lane, st, now);
        const id = `escalate:${lane.key}:${noticeId(d, lane)}:${lane.progressEpoch ?? 0}`;
        if (
          !underInboxLock(d, leadRef, (inbox) => d.store.enqueueOnce(inbox, { at: now, from: "duty", text: msg, id }))
        ) {
          events.push(busy(lane, "the lead's"));
          continue;
        }
        lane.escalatedAt = now;
        lane.log.push({ at: now, kind: "escalate", text: msg });
        d.store.saveLane(lane);
        events.push({ lane: lane.key, action: "escalated" });
        await flushInbox(d, leadRef);
        continue;
      }
      // Older binaries could retain a prior epoch's marker; only this epoch's queued alert ends nudges.
      if (lane.escalatedAt !== undefined && lane.escalatedAt > progressOf(lane)) continue;
      if (st === "working" || st === "blocked" || st === "error") continue;
      // Nudges answer silence: any report or a working pane restarts the quiet time, but only progress resets the count.
      const quietMin = (now - Math.max(progressOf(lane), lane.lastActivityAt)) / 60_000;
      const due = NUDGE_MINUTES[lane.nudges];
      if (due === undefined || quietMin < due) continue;
      const since = progressOf(lane);
      const waiting = lane.status === "waiting";
      const whole = waiting ? waitingTarget(lane) : "";
      const vars = {
        key: lane.key,
        minutes: String(Math.floor(quietMin)),
        since: hhmm(since),
        age: ageText(now - since),
        dori: d.doriCmd,
        ...(waiting
          ? { target: "", wholeTarget: indented(whole).join("\n"), waitingSince: hhmm(waitingSinceOf(lane)) }
          : {}),
      };
      // Built and queued before it is counted: a nudge that could not be built or queued is not used up. A waiting
      // nudge's first line names the target in what it leaves of WIDTH beside the key (at most 40 columns), so the time
      // shows; its body names the target whole, since a cut link or job id names nothing the lane can check. A
      // template from before {{wholeTarget}} (DORI_PROMPTS_DIR) gets the whole target under its first line instead.
      const name = waiting ? "nudge-waiting.md" : "nudge.md";
      const template = readFileSync(promptFile(name), "utf8");
      const room = waiting ? WIDTH - Bun.stringWidth(fill(template, vars).split("\n")[0]!) : 0;
      const target = waitingOn(lane, Math.max(1, room));
      const [first, ...rest] = fill(template, waiting ? { ...vars, target } : vars).split("\n");
      const named = template.includes("{{wholeTarget}}") || (target === whole && template.includes("{{target}}"));
      const text = [first, ...(waiting && !named ? indented(whole) : []), ...rest].join("\n");
      const ref = lane.sessionRef;
      const id = `nudge:${lane.key}:${noticeId(d, lane)}:${lane.progressEpoch ?? 0}:${lane.nudges + 1}`;
      if (!underInboxLock(d, ref, (inbox) => d.store.enqueueOnce(inbox, { at: now, from: "duty", text, id }))) {
        events.push(busy(lane, "the lane's"));
        continue;
      }
      lane.nudges += 1;
      lane.log.push({ at: now, kind: "nudge", text: `idle ${Math.floor(quietMin)} min` });
      d.store.saveLane(lane);
      events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
      await flushInbox(d, ref);
    } catch (e) {
      // One lane's failed status read or delivery must not end the loop for the other lanes.
      events.push({ lane: listed.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  const count = (pred: (a: string) => boolean) => events.filter((e) => pred(e.action)).length;
  d.usage.touch();
  d.usage.duty({
    ticks: 1,
    flushed: count((a) => a === "flushed"),
    nudges: count((a) => a.startsWith("nudge-")),
    escalations: count((a) => a === "escalated"),
    lost: count((a) => a === "lost"),
  });
  return events;
}
