import { readFileSync } from "node:fs";
import { DeliveryUncertain, failureDetail } from "./delivery.ts";
import { type Deps, fill, promptFile } from "./harness.ts";
import { runHook } from "./hooks.ts";
import { flushInbox } from "./inbox.ts";
import { oweLead } from "./inbox-files.ts";
import { payLead } from "./inbox-merge.ts";
import { underInboxLock } from "./duty-inbox.ts";
import { Refusal } from "./refusal.ts";
import { refText } from "./refs.ts";
import { observeWait, renderWait, waitEnded, waitKey } from "./wait.ts";
import { escalation, stalled, waitingOn, waitingSinceOf, waitingTarget } from "./progress.ts";
import type { SessionRef } from "./runtime/types.ts";
import { sameLaneRegistration } from "./store-lanes.ts";
import type { Lane } from "./store-types.ts";
import { ageText, hhmm, indented, WIDTH } from "./fit.ts";

/** Quiet minutes before the first and second nudge; the lead is told at ESCALATE_MINUTES without progress. */
export const NUDGE_MINUTES = [10, 20] as const;

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };

/** An open lane the duty loop watches. */
const watched = (lane: Lane): boolean => lane.status === "working" || lane.status === "waiting";

const busy = (lane: Lane, whose: string): DutyEvent => ({
  lane: lane.key,
  action: "notice-deferred",
  detail: `${whose} inbox is being flushed; tried again on the next pass`,
});

type Nudge = { lane: Lane; at: number; id: string; text: string; minutes: number };

function queueNudge(d: Deps, { lane, at, id, text, minutes }: Nudge, events: DutyEvent[]): SessionRef | undefined {
  let counted = false;
  const nudged = underInboxLock(
    d,
    () => d.store.lane(lane.key)?.sessionRef,
    (inbox) => {
      counted = d.store.withCurrentLane(lane.key, (current, save) => {
        // Resolution may follow a lane's switched session, but not a new lane or a report that made this nudge stale.
        if (
          !current ||
          !watched(current) ||
          current.noticeId !== lane.noticeId ||
          current.nudges !== lane.nudges ||
          current.progressEpoch !== lane.progressEpoch ||
          current.lastActivityAt !== lane.lastActivityAt ||
          current.escalatedAt !== lane.escalatedAt ||
          current.status !== lane.status ||
          (current.status === "waiting" &&
            (waitingTarget(current) !== waitingTarget(lane) || waitingSinceOf(current) !== waitingSinceOf(lane)))
        )
          return false;
        d.store.enqueueOnce(inbox, { at, from: "duty", text, id });
        current.nudges += 1;
        current.log.push({ at, kind: "nudge", text: `idle ${minutes} min` });
        save(current);
        events.push({ lane: current.key, action: `nudge-${current.nudges}` });
        return true;
      });
    },
  );
  if (!nudged) events.push(busy(lane, "the lane's"));
  return counted ? nudged : undefined;
}

/**
 * Queues the LOST notice for the lead under a fixed id. With no lead registered, or while a flush holds the lead's
 * inbox, it waits in a queue of its own (`oweLead`), not in the lane record: the same key may be started again,
 * replacing that record, before the notice is moved. Returns the lead's inbox it reached, if it did.
 */
function queueLost(d: Deps, lane: Lane, now: number): SessionRef | undefined {
  const text = `[LOST ${lane.key}] pane ${refText(lane.sessionRef)} closed without a final answer`;
  const msg = { at: now, from: "duty", text, id: `lost:${lane.key}:${lane.noticeId}` };
  const inbox = underInboxLock(
    d,
    () => d.store.roles().lead,
    (at) => d.store.enqueueOnce(at, msg),
  );
  if (inbox === undefined) oweLead(d.store.root, msg);
  return inbox;
}

/** Once a lead is registered, the notices kept for it move into its inbox, under its lock (else on a later pass). */
function payOwed(d: Deps): void {
  underInboxLock(
    d,
    () => d.store.roles().lead,
    (inbox) => payLead(d.store.root, d.store.inboxPath(inbox)),
  );
}

/** One proactive pass: flush inboxes of panes that became idle, nudge silent lanes, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  payOwed(d);
  for (const ref of d.store.inboxPanes()) {
    const paneId = refText(ref);
    try {
      const result = await flushInbox(d, ref);
      if (result === "delivered") events.push({ pane: paneId, action: "flushed" });
      if (result === "no-agent") {
        events.push({
          pane: paneId,
          action: "inbox-held",
          detail: `no agent in front; ${d.store.queued(ref).length} message(s) kept`,
        });
      }
      const held = d.store.queued(ref).filter((m) => m.attempt?.state === "ambiguous").length;
      if (held > 0)
        events.push({ pane: paneId, action: "delivery-ambiguous", detail: `${held} message(s) held, not resent` });
    } catch (e) {
      if (e instanceof Refusal) events.push({ pane: paneId, action: "inbox-target-gone" });
      else if (e instanceof DeliveryUncertain && !e.typed)
        events.push({ pane: paneId, action: "delivery-ambiguous", detail: failureDetail(e) });
      else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const listed of d.store.lanes()) {
    if (!watched(listed)) continue;
    try {
      const probe = await d.runtimes.for(listed.sessionRef).probe(listed.sessionRef);
      const st = probe.status;
      const notice = d.store.withCurrentLane<SessionRef | Nudge | undefined>(listed.key, (lane, save) => {
        if (!lane || !watched(lane) || !sameLaneRegistration(listed, lane)) return;
        const now = d.now();
        if (
          lane.wait &&
          listed.wait &&
          waitKey(lane.wait.target) === waitKey(listed.wait.target) &&
          lane.wait.startedAt === listed.wait.startedAt
        ) {
          const observed = observeWait(lane.wait, probe);
          if (JSON.stringify(observed) !== JSON.stringify(lane.wait)) {
            if (waitEnded(observed) && !waitEnded(lane.wait))
              events.push({
                lane: lane.key,
                action: "wait-ended",
                detail: `${renderWait(observed)}; lane state and progress unchanged`,
              });
            lane.wait = observed;
            save(lane);
          }
        }
        if (st === "gone") {
          const leadRef = d.store.roles().lead;
          const queued = queueLost(d, lane, now);
          lane.status = "lost";
          lane.log.push({ at: now, kind: "lost", text: "pane disappeared without READY" });
          save(lane);
          void runHook(d, "onLost", { key: lane.key, text: "pane disappeared without READY", evidence: "" });
          events.push({ lane: lane.key, action: "lost" });
          if (!queued) {
            if (leadRef) events.push(busy(lane, "the lead's"));
            else
              events.push({ lane: lane.key, action: "lost-no-lead", detail: "no lead registered; told once one is" });
          }
          return queued;
        }
        if (st === "working") {
          lane.lastActivityAt = now;
          save(lane);
        }
        if (stalled(lane, now)) {
          const lead = () => d.store.roles().lead;
          if (!lead()) {
            events.push({ lane: lane.key, action: "escalate-no-lead", detail: "no lead registered; told once one is" });
            return;
          }
          const msg = escalation(lane, st, now);
          const id = `escalate:${lane.key}:${lane.noticeId}:${lane.progressEpoch}`;
          const told = underInboxLock(d, lead, (inbox) =>
            d.store.enqueueOnce(inbox, { at: now, from: "duty", text: msg, id }),
          );
          if (!told) {
            events.push(busy(lane, "the lead's"));
            return;
          }
          lane.escalatedAt = now;
          lane.log.push({ at: now, kind: "escalate", text: msg });
          save(lane);
          events.push({ lane: lane.key, action: "escalated" });
          return told;
        }
        if (lane.escalatedAt !== undefined) return;
        if (st === "working" || st === "blocked" || st === "error") return;
        const quietMin = (now - Math.max(lane.progressAt, lane.lastActivityAt)) / 60_000;
        const due = NUDGE_MINUTES[lane.nudges];
        if (due === undefined || quietMin < due) return;
        const since = lane.progressAt;
        const waiting = lane.status === "waiting";
        const whole = waiting ? waitingTarget(lane) : "";
        const vars = {
          key: lane.key,
          minutes: String(Math.floor(quietMin)),
          since: hhmm(since),
          age: ageText(now - since),
          cataly: d.catalyCmd,
          ...(waiting
            ? { target: "", wholeTarget: indented(whole).join("\n"), waitingSince: hhmm(waitingSinceOf(lane)) }
            : {}),
        };
        const name = waiting ? "nudge-waiting.md" : "nudge.md";
        const template = readFileSync(promptFile(name), "utf8");
        const room = waiting ? WIDTH - Bun.stringWidth(fill(template, vars).split("\n")[0]!) : 0;
        const target = waitingOn(lane, Math.max(1, room));
        const [first, ...rest] = fill(template, waiting ? { ...vars, target } : vars).split("\n");
        const named = template.includes("{{wholeTarget}}") || (target === whole && template.includes("{{target}}"));
        const text = [first, ...(waiting && !named ? indented(whole) : []), ...rest].join("\n");
        const id = `nudge:${lane.key}:${lane.noticeId}:${lane.progressEpoch}:${lane.nudges + 1}`;
        return { lane, at: now, id, text, minutes: Math.floor(quietMin) };
      });
      const queued = notice && ("text" in notice ? queueNudge(d, notice, events) : notice);
      if (queued) await flushInbox(d, queued);
    } catch (e) {
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
