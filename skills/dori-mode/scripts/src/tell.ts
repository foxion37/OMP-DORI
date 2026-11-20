import { withDeliveryLock } from "./delivery-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { type Delivery, sendVerified, statusLookup, UnsafeTextError } from "./sessions.ts";

/**
 * `dori tell`: the lead's one message to a lane's session, sent through `sendVerified` so a shell, a stopped agent or an
 * approval prompt gets nothing and the text is never sent twice. Exit codes keep the outcomes apart: 0 confirmed,
 * 3 unconfirmed (the text may have arrived; resending could duplicate it), 2 failed (nothing was sent).
 */
export type TellResult = { readonly line: string; readonly code: 0 | 2 | 3 };

const failed = (lane: Lane, why: string): TellResult => ({
  line: `TELL_FAILED ${lane.key} delivery=failed: ${why}; nothing was sent`,
  code: 2,
});

/**
 * The lane is read again under its delivery lock, which `dori pause` holds through its whole pause, so a pause that
 * finished after the caller read the lane holds the send instead of starting a turn the owner asked to hold.
 */
export const tellLane = async (deps: FlowDeps, lane: Lane, text: string): Promise<TellResult> => {
  const held = await withDeliveryLock(deps, lane.key, async () => {
    const current = await deps.registry.read(lane.key);
    if (!current || statusOf(current) === "closed") return failed(lane, "the lane was closed");
    if (current.nativeCloseIntent) return failed(current, "native close is in progress");
    return await send(deps, current, text);
  });
  return held.ok ? held.value : failed(lane, `a pause or another tell holds the lane's delivery lock (${held.holder})`);
};

const send = async (deps: FlowDeps, lane: Lane, text: string): Promise<TellResult> => {
  // The owner said wait: a message would start a turn in a paused lane, which only `dori resume` may do.
  if (statusOf(lane) === "paused") return failed(lane, "the lane is paused; resume it first");
  const ref = sessionOf(lane);
  if (!ref) return failed(lane, "the lane has no session");
  let delivery: Delivery;
  try {
    delivery = await sendVerified(runtimesOf(deps), deps.clock, ref, text);
  } catch (e) {
    if (e instanceof UnsafeTextError) return failed(lane, "the text contains a backtick or $(");
    throw e;
  }
  if (delivery === "delivered") return { line: `TOLD ${lane.key} delivery=confirmed`, code: 0 };
  if (delivery === "failed") {
    // sendVerified does not say which hold applied; the status read now tells a shell from a blocked agent.
    const now = await statusLookup(runtimesOf(deps), ref);
    const seen = now.error !== undefined ? "unreadable" : (now.status ?? "no agent");
    return failed(lane, `no agent ready for input (status now: ${seen})`);
  }
  return {
    line: `TELL_UNCONFIRMED ${lane.key} delivery=unconfirmed: no move to working was seen (a working agent gets it as queued input); do not resend`,
    code: 3,
  };
};
