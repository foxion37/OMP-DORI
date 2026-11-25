import {
  liveSessions,
  nativeRequest,
  object,
  selectSession,
  type Request,
  type Session,
} from "../../../../src/remote/client.ts";
import { remotePolicy } from "../../../../src/remote/policy.ts";
import { HeadlessRuntime } from "../../../../src/runtime/headless.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { alive } from "./checkpoint-lock.ts";
import { parseOwnershipRef, withDeliveryLock, withTerminalOwnershipLock } from "./delivery-lock.ts";
import { type Lane, LANE_KEY, sessionOf } from "./registry.ts";
import { openRemoteSession, wakeRemoteSession } from "./remote-launch.ts";
import { RemoteRecords } from "./remote-records.ts";
import { runtimesOf } from "./run.ts";

const OPERATIONS = new Set([
  "sessions",
  "info",
  "read",
  "events",
  "send",
  "receipt",
  "interrupt",
  "model",
  "close",
  "attach",
  "open",
  "wake",
]);

const validRef = (raw: unknown): boolean => {
  if (raw === undefined) return true;
  const ref = object(raw);
  return (
    (ref?.["runtime"] === "headless" || ref?.["runtime"] === "tern") &&
    typeof ref["id"] === "string" &&
    ref["id"].length > 0
  );
};

const belongsToLane = (lane: Lane, target: Session, ref: SessionRef | undefined): boolean =>
  lane.session === target.session ||
  lane.nativeCloseIntent?.session === target.session ||
  (target.sessionFile !== undefined && lane.sessionFile === target.sessionFile) ||
  (ref !== undefined &&
    (sessionOf(lane)?.id === ref.id ||
      lane.nativeCloseIntent?.ref?.id === ref.id ||
      (ref.runtime === "headless" && lane.lifecycleEpoch === ref.id))) ||
  (ref === undefined && !lane.session);

async function requireStandaloneClose(deps: FlowDeps, target: Session, ref: SessionRef | undefined): Promise<void> {
  const guidance = "inspect the lane locally and use cataly close or cataly park";
  const unavailable = `Remote close held: lane ownership is unconfirmed; ${guidance}`;
  if (
    (target.pane !== undefined && !ref) ||
    (target.sessionFile !== undefined && typeof target.sessionFile !== "string")
  )
    throw new Error(unavailable);
  const { lanes, unreadable } = await deps.registry.scan(true).catch((error: unknown) => {
    throw new Error(unavailable, { cause: error });
  });
  if (unreadable.length) throw new Error(unavailable);
  const matches: Lane[] = [];
  for (const lane of lanes) {
    const intent = lane.nativeCloseIntent;
    if (
      !LANE_KEY.test(lane.key) ||
      [lane.session, lane.sessionFile, lane.lifecycleEpoch].some(
        (field) => field !== undefined && (typeof field !== "string" || field.length === 0),
      ) ||
      !validRef(lane.sessionRef) ||
      (intent !== undefined && (!intent || typeof intent.session !== "string" || !intent.ref || !validRef(intent.ref)))
    )
      throw new Error(unavailable);
    if (belongsToLane(lane, target, ref)) matches.push(lane);
  }
  if (!matches.length) return;
  const owner = matches[0];
  if (matches.length !== 1 || !owner) throw new Error(unavailable);
  // A matching row remains a refusal even if it moves or is locked by a local lifecycle operation.
  const held = await withDeliveryLock(deps, owner.key, () => deps.registry.read(owner.key), 0).catch(
    (error: unknown) => {
      throw new Error(unavailable, { cause: error });
    },
  );
  if (!held.ok || !held.value || !belongsToLane(held.value, target, ref)) throw new Error(unavailable);
  throw new Error(`Remote close held for registered lane ${owner.key}; ${guidance}`);
}

/** Same-host operations on live OMP sessions: headless lanes via their supervisor, others via their endpoint. */
export async function remoteOperation(deps: FlowDeps, request: Request): Promise<unknown> {
  const { stateDir } = deps.config;
  if (!OPERATIONS.has(request.op)) throw new Error("Unsupported Cataly remote operation");
  if (request.op === "open") return await openRemoteSession(deps, request);
  if (request.op === "sessions") {
    const lanes = await deps.registry.list();
    return (await liveSessions(stateDir)).map((row) => ({
      ...row,
      lane: lanes.find((lane) => lane.session === row.session)?.key ?? null,
    }));
  }
  if (!request.session || request.session.length > 128) throw new Error("An OMP session ID is required");
  if (request.op === "wake") {
    if (!remotePolicy(stateDir).wake) throw new Error("Session wake is disabled on this Cataly installation");
    return await wakeRemoteSession(deps, request.session);
  }
  const target = selectSession(await liveSessions(stateDir), request.session);
  if (request.generation !== undefined && request.generation !== target.generation)
    throw new Error("OMP session generation changed; inspect its current state first");
  if (request.op === "info") return target;
  if (request.op === "attach") return { mode: "transcript", session: target.session, generation: target.generation };
  const targetRef = typeof target.pane === "string" ? parseOwnershipRef(target.pane) : undefined;
  const headless = targetRef?.runtime === "headless" ? targetRef : undefined;
  if (headless && !["read", "events"].includes(request.op)) {
    if (request.op === "close") await requireStandaloneClose(deps, target, headless);
    const runtime = runtimesOf(deps).for(headless);
    if (!(runtime instanceof HeadlessRuntime)) throw new Error("Headless supervisor unavailable");
    const id = request.id;
    const mutation = async () => {
      switch (request.op) {
        case "send":
          if (!id || !request.text) throw new Error("Native send needs an ID and text");
          return await runtime.remoteSend(headless, target.session, {
            id,
            text: request.text,
            delivery: request.steer ? "steer" : "prompt",
          });
        case "receipt":
          if (!id) throw new Error("Native receipt needs an ID");
          return (await runtime.remoteReceipt(headless, target.session, id)) ?? { id, status: "not-found" };
        case "interrupt":
          return await runtime.remoteInterrupt(headless, target.session);
        case "model":
          if (!request.model) throw new Error("Native model change needs a model");
          return await runtime.remoteModel(headless, target.session, request.model);
        case "close":
          return await runtime.remoteClose(headless, target.session, request.force);
        default:
          throw new Error("Unsupported headless remote operation");
      }
    };
    const result = await (request.op === "close"
      ? new RemoteRecords(stateDir).close(target.session, mutation)
      : mutation());
    return { ...result, session: target.session, generation: target.generation };
  }
  const call = () => nativeRequest(stateDir, { ...request, session: target.session, generation: target.generation });
  if (request.op === "close") {
    // Hold the adoption fence through the ownership decision, shutdown outcome and final receipt write.
    const held = await withTerminalOwnershipLock(deps, targetRef, async () => {
      await requireStandaloneClose(deps, target, targetRef);
      return await new RemoteRecords(stateDir).close(target.session, async () => {
        await call();
        for (let check = 0; check < 20; check++) {
          const visible = (await liveSessions(stateDir)).find((row) => row.session === target.session);
          if (!visible && target.pid !== undefined && !alive(target.pid))
            return { status: "closed", session: target.session };
          if (visible && visible.generation !== target.generation) break;
          await deps.clock.sleep(100);
        }
        return { status: "close-unconfirmed", session: target.session };
      });
    });
    if (!held.ok) throw new Error("Remote close held: terminal ownership is busy; retry after local lifecycle work");
    return held.value;
  }
  const result = await call();
  if (request.op === "send") return { ...object(result), session: target.session, generation: target.generation };
  return result;
}
