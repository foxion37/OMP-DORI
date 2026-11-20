import { randomUUID } from "node:crypto";
import { mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { configPath, fill } from "./config.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { type FlowDeps, movedOn } from "./done-flow.ts";
import { quoteForPane } from "./launch-footer.ts";
import { LaunchError } from "./launch.ts";
import { confirmedLaneState, isBareLaneShell, nativeGoalStatus, resumeFile } from "./lifecycle-session.ts";
import { resumeLane, type PauseResult } from "./pause.ts";
import { type Lane, sameLaneGeneration, sessionFields, sessionOf, statusOf, withStatus } from "./registry.ts";
import { Reports } from "./reports.ts";
import { iso, runtimesOf } from "./run.ts";
import { listSessions, sendVerified } from "./sessions.ts";
import { laneLaunchEnv } from "./slack-token.ts";
import { withThreadLock } from "./thread-groups.ts";

type ReopenCommit = { ref: SessionRef; opened: Lane | null; at: string; epoch: string };

/** Reopen is an explicit operator action; neither a timer nor a ready condition calls it. */
export const reopenLane = async (deps: FlowDeps, seen: Lane, note?: string): Promise<PauseResult> => {
  const held = await withDeliveryLock(deps, seen.key, async (): Promise<PauseResult> => {
    const lane = await deps.registry.read(seen.key);
    if (!lane || !sameLaneGeneration(seen, lane))
      return { lane: lane ?? seen, lines: [await movedOn(deps, seen, "reopen")], code: 3 };
    const fail = (text: string, current = lane): PauseResult => ({ lane: current, lines: [text], code: 3 });
    if (lane.nativeCloseIntent) return fail(`HELD ${lane.key}: native close is in progress`);
    const status = statusOf(lane);
    const preparedPark = status === "paused" && lane.hold?.outcome === "parked";
    if (status !== "closed" && !preparedPark)
      return fail(`REFUSED ${lane.key}: not closed; use resume for a paused lane`);
    const oldRef = sessionOf(lane);
    if (preparedPark && !oldRef) return fail(`REOPEN_UNVERIFIED ${lane.key}: previous pane identity missing`);
    if (!mayRunOmpArgv(deps.config.agentCommand)) throw new LaunchError("reopen requires an OMP agentCommand");
    if (note && /`|\$\(/.test(note)) throw new LaunchError("reopen note contains unsupported delivery syntax");
    const file = await resumeFile(deps, lane);
    const template = deps.config.agentCommand;
    if (
      template.at(-1) !== "{prompt}" ||
      template.slice(0, -1).some((p) => p.includes("{prompt}") || /^--(?:resume|session|continue)(?:=|$)/.test(p))
    )
      throw new LaunchError("reopen requires agentCommand ending in a positional {prompt}, without session selectors");
    const rts = runtimesOf(deps);
    const group = await withThreadLock(deps, lane, async (): Promise<PauseResult | ReopenCommit> => {
      const latest = await deps.registry.read(lane.key);
      if (!latest || latest.thread !== lane.thread || !sameLaneGeneration(lane, latest))
        return fail(await movedOn(deps, lane, "reopen"));
      const peers = await deps.registry
        .open()
        .then((open) => listSessions(rts, { lanes: [lane, ...open] }))
        .catch(() => null);
      if (!peers) return fail(`REOPEN_UNVERIFIED ${lane.key}: cannot list existing panes; no pane created`);
      for (const entry of peers) {
        if (oldRef && entry.ref.runtime === oldRef.runtime && entry.ref.id === oldRef.id)
          return fail(`REFUSED ${lane.key}: previous pane still exists`);
        try {
          const peer = await rts.for(entry.ref).probe(entry.ref);
          if (peer.sessionId === lane.session)
            return fail(`REFUSED ${lane.key}: recorded session is already running in ${entry.ref.id}`);
          if (peer.status !== "gone" && !peer.sessionId && !isBareLaneShell(peer))
            return fail(`REOPEN_UNVERIFIED ${lane.key}: unknown session in ${entry.ref.id}; no pane created`);
        } catch {
          return fail(`REOPEN_UNVERIFIED ${lane.key}: cannot inspect session ${entry.ref.id}; no pane created`);
        }
      }
      const stillCurrent = await deps.registry.read(lane.key);
      if (!stillCurrent || stillCurrent.thread !== lane.thread || !sameLaneGeneration(lane, stillCurrent))
        return fail(await movedOn(deps, lane, "reopen"));
      const env = laneLaunchEnv(deps.env ?? process.env, deps.env?.["DORI_CONFIG"] ?? configPath(), deps.config);
      const ref = await rts.default.create({
        name: lane.key,
        role: "lane",
        container: "tab",
        cwd: lane.cwd ?? deps.config.defaultCwd,
        env,
        ...(deps.config.laneWorkspace ? { group: deps.config.laneWorkspace } : {}),
      });
      const at = iso(deps.clock);
      const epoch = randomUUID();
      const opened = await deps.registry.transition(lane, (current) => {
        const {
          closedAt: _closed,
          receipt: _receipt,
          claim: _claim,
          objection: _objection,
          hold: _hold,
          tab: _tab,
          sessionRef: _ref,
          pane: _pane,
          ...rest
        } = current;
        return withStatus(rest, "paused", `reopening: ${note ?? "explicit operator request"}`, at, {
          ...sessionFields(ref),
          sessionFile: file,
          openedAt: at,
          lifecycleEpoch: epoch,
          pausedFrom: "working",
          lastReplyAt: deps.clock.now(),
          // A new generation starts with no report receipt or previously observed screen report.
          lastPostedReport: undefined,
          lastPostedReportId: undefined,
          lastPostedReportOwner: undefined,
          lastSeenReport: undefined,
          lastFreshnessNote: undefined,
          pausedSeenWorking: undefined,
        });
      });
      return { ref, opened, at, epoch };
    });
    if (!group.ok) return fail(`HELD ${lane.key} thread close in flight (${group.holder})`);
    if ("code" in group.value) return group.value;
    const { ref, opened, at, epoch } = group.value;
    if (!opened) {
      await rts.for(ref).close(ref, "session");
      return fail(await movedOn(deps, lane, "reopen"));
    }
    // The new paused generation exists even if startup/readback fails and the operator later uses resume.
    new Reports(deps.config.stateDir).append({
      type: "reopen",
      key: lane.key,
      at,
      generation: epoch,
      text: `lane reopening in ${ref.id}`,
    });
    const argv = [
      ...fill(template.slice(0, -1), { model: lane.model ?? deps.config.defaultModel }),
      `--resume=${file}`,
    ];
    try {
      await rts.for(ref).start(ref, argv.map(quoteForPane).join(" "));
    } catch (error) {
      return fail(
        `REOPEN_UNVERIFIED ${lane.key}: start failed (${String(error)}); pane=${ref.id}, inspect before resume`,
        opened,
      );
    }
    // Never resume a foreign/new session or treat an unknown receipt as an idle agent.
    const attempts = Math.max(1, Math.ceil(deps.config.startupWaitSeconds));
    let ready = false;
    for (let n = 0; n < attempts; n++) {
      const goal = nativeGoalStatus(await confirmedLaneState(deps, opened, ref));
      if (goal === "paused" || goal === "none" || goal === "complete" || goal === "dropped") {
        ready = true;
        break;
      }
      await deps.clock.sleep(1000);
    }
    if (!ready)
      return fail(
        `REOPEN_UNVERIFIED ${lane.key}: same paused session not confirmed in ${ref.id}; inspect before resume`,
        opened,
      );
    const resumed = await resumeLane(deps, opened, note ?? "explicit reopen", true);
    if (resumed.code !== 0) return resumed;
    if (note) {
      const state = await confirmedLaneState(deps, resumed.lane, ref);
      const current = await deps.registry.read(lane.key);
      if (!current || !sameLaneGeneration(resumed.lane, current))
        return fail(await movedOn(deps, resumed.lane, "reopen note"), current ?? resumed.lane);
      if (!nativeGoalStatus(state))
        return fail(`REOPEN_UNVERIFIED ${lane.key}: session or goal unverified; note not sent`, current);
    }
    const delivery = note
      ? await sendVerified(rts, deps.clock, ref, `[LEAD] ${note}`, undefined, lane.session)
      : undefined;
    return {
      lane: resumed.lane,
      code: delivery && delivery !== "delivered" ? 3 : 0,
      lines: [
        `REOPENED ${lane.key} pane=${ref.id} session=${lane.session} goal resumed${delivery ? ` note=${delivery}; never resend automatically` : ""}`,
      ],
    };
  });
  return held.ok ? held.value : { lane: seen, lines: [`HELD ${seen.key} delivery lock: ${held.holder}`], code: 3 };
};
