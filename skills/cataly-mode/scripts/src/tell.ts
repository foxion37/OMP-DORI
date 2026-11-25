import { withDeliveryLock } from "./delivery-lock.ts";
import { type DeliveryRecord, DeliveryState } from "./delivery-state.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type Lane, sameLaneGeneration, sessionOf, statusOf } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { type Delivery, sendVerified, statusLookup, UnsafeTextError } from "./sessions.ts";

/**
 * `cataly tell`: the lead's one message to a lane's session, sent through `sendVerified` so a shell, a stopped agent or an
 * approval prompt gets nothing and the text is never sent twice. Exit codes keep the outcomes apart: 0 confirmed,
 * 3 unconfirmed (the text may have arrived; resending could duplicate it), 2 failed (nothing was sent).
 */
export type TellResult = { readonly line: string } & (
  { readonly code: 2; readonly held?: true } | { readonly code: 0 | 3 }
);
type TellOptions = { readonly locked?: boolean; readonly waitMs?: number; readonly idleOnly?: boolean };

const failed = (lane: Lane, why: string): TellResult => ({
  line: `TELL_FAILED ${lane.key} delivery=failed: ${why}; nothing was sent`,
  code: 2,
});

/**
 * The lane is read again under its delivery lock, which `cataly pause` holds through its whole pause, so a pause that
 * finished after the caller read the lane holds the send instead of starting a turn the owner asked to hold.
 */
export const tellLane = async (
  deps: FlowDeps,
  lane: Lane,
  text: string,
  options: TellOptions = {},
): Promise<TellResult> => {
  const state = new DeliveryState(deps.registry, lane.key);
  const dispatch = async (): Promise<TellResult> => {
    const current = await deps.registry.read(lane.key);
    if (!current || statusOf(current) === "closed") return failed(lane, "the lane was closed");
    if (current.nativeCloseIntent) return failed(current, "native close is in progress");
    // An owner pause wins even when the caller looked up an earlier lane status.
    if (current.hold?.outcome === "parked") return failed(current, "the lane is parked; reopen it first");
    if (statusOf(current) === "paused") return failed(current, "the lane is paused; resume it first");
    const ref = sessionOf(current);
    if (!ref) return failed(current, "the lane has no session");
    const seen = sessionOf(lane);
    if (
      !sameLaneGeneration(lane, current) ||
      !seen ||
      seen.runtime !== ref.runtime ||
      seen.id !== ref.id ||
      seen.group !== ref.group ||
      seen.container !== ref.container ||
      lane.session !== current.session ||
      lane.sessionFile !== current.sessionFile ||
      lane.requestId !== current.requestId ||
      lane.runId !== current.runId
    )
      return failed(current, "the lane identity changed");
    if (ref.runtime === "headless" && !current.session)
      return failed(current, "the lane has no confirmed native session");
    const pending = state.read();
    if (pending?.status === "uncertain")
      return {
        line: `TELL_HELD ${lane.key} delivery=held: request=${pending.id} is uncertain; this message was not sent; inspect cataly tell ${lane.key} --status, then --resolve ${pending.id} --note REASON to end only its hold`,
        code: 2,
        held: true,
      };
    const request: DeliveryRecord = {
      id: crypto.randomUUID(),
      openedAt: current.openedAt,
      session: ref,
      at: new Date(deps.clock.now()).toISOString(),
      status: "uncertain",
    };
    // If submission or confirmation is interrupted, the prewritten fence still owns this dispatch.
    state.write(request);
    const unconfirmed: TellResult = {
      line: `TELL_UNCONFIRMED ${lane.key} delivery=unconfirmed: request=${request.id}; the runtime did not confirm delivery; later messages are held; do not resend`,
      code: 3,
    };
    const runtimes = runtimesOf(deps);
    const expectedSessionId = ref.runtime === "headless" || current.lifecycleEpoch ? current.session : undefined;
    let delivery: Delivery;
    try {
      delivery = await sendVerified(
        runtimes,
        deps.clock,
        ref,
        text,
        options.idleOnly ? "idle" : undefined,
        expectedSessionId,
        options.idleOnly,
      );
    } catch (error) {
      if (!(error instanceof UnsafeTextError)) {
        console.error(unconfirmed.line);
        throw error;
      }
      state.write({ ...request, status: "failed", settledAt: new Date(deps.clock.now()).toISOString() });
      return failed(current, "the text contains a backtick or $(");
    }
    if (delivery === "unconfirmed") return unconfirmed;
    state.write({
      ...request,
      status: delivery === "delivered" ? "confirmed" : "failed",
      settledAt: new Date(deps.clock.now()).toISOString(),
    });
    if (delivery === "delivered") return { line: `TOLD ${lane.key} delivery=confirmed`, code: 0 };
    const now = await statusLookup(runtimes, ref);
    const status = now.error !== undefined ? "unreadable" : (now.status ?? "no agent");
    return failed(current, `no agent ready for input (status now: ${status})`);
  };
  if (options.locked) return dispatch();
  const held = await withDeliveryLock(deps, lane.key, dispatch, options.waitMs);
  return held.ok ? held.value : failed(lane, `a pause or another tell holds the lane's delivery lock (${held.holder})`);
};

/** A claim or objection is already recorded; a notification never waits inside a delivery callback. */
export const notifyLane = async (deps: FlowDeps, lane: Lane, text: string, locked = false): Promise<void> => {
  if (!sessionOf(lane)) return;
  const delivery = await tellLane(deps, lane, text, { locked, waitMs: 0 });
  if (delivery.code !== 0)
    console.log(`LANE_NOTIFY_${delivery.code === 2 ? "HELD" : "UNCONFIRMED"} ${lane.key} ${delivery.line}`);
};

/** End only this exact local hold, without replaying or deciding the original delivery. */
export const resolveTell = async (deps: FlowDeps, key: string, id: string, note: string): Promise<TellResult> => {
  const state = new DeliveryState(deps.registry, key);
  const held = await withDeliveryLock(deps, key, async (): Promise<TellResult> => {
    const current = state.read();
    if (
      !id.trim() ||
      !note.trim() ||
      !current ||
      current.id !== id ||
      (current.status !== "uncertain" && current.status !== "released")
    )
      return {
        line: `TELL_RESOLVE_REFUSED ${key} request=${id}: exact uncertain request ID and a nonempty note are required; inspect cataly tell ${key} --status`,
        code: 2,
      };
    if (current.status === "uncertain")
      state.write({
        ...current,
        status: "released",
        settledAt: new Date(deps.clock.now()).toISOString(),
        note: note.trim(),
      });
    return {
      line: `TELL_RESOLVED ${key} request=${id}: hold released only; original delivery remains unknown; nothing sent or replayed`,
      code: 0,
    };
  });
  return held.ok
    ? held.value
    : {
        line: `TELL_RESOLVE_HELD ${key}: delivery is in flight (${held.holder}); nothing changed`,
        code: 2,
      };
};
