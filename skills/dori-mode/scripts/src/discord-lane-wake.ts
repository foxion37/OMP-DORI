import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseRef, type SessionRef } from "../../../../src/runtime/types.ts";
import { configPath } from "./config.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { exactDiscordLaneTranscript } from "./discord-lane-transcript.ts";
import { wakeCommand } from "./discord-lane-wake-command.ts";
import { ownsWakeLease, type WakeLease, wakeLeaseState } from "./discord-lane-wake-lease.ts";
import {
  discordWakeBoundEpoch,
  discordWakeCompletedEpoch,
  discordWakePendingEpoch,
  isDiscordWakePending,
} from "./discord-lane-wake-pending.ts";
import type { FlowDeps } from "./done-flow.ts";
import { sampleHost } from "./host-guard.ts";
import { readPaneState } from "./lane-state.ts";
import { quoteForPane } from "./launch-footer.ts";
import { isBareLaneShell, nativeGoalStatus } from "./lifecycle-session.ts";
import {
  type Lane,
  LANE_KEY,
  RESERVED_LANE_KEY,
  sameLaneGeneration,
  sessionFields,
  sessionOf,
  statusOf,
} from "./registry.ts";
import { canLaunch } from "./routing.ts";
import { runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";
import { listSessions } from "./sessions.ts";
import { laneLaunchEnv } from "./slack-token.ts";

export type DiscordLaneWakeResult =
  | { readonly kind: "started"; readonly ref: SessionRef }
  | { readonly kind: "held"; readonly reason: string }
  | { readonly kind: "unconfirmed"; readonly reason: string };

const held = (reason: string): DiscordLaneWakeResult => ({ kind: "held", reason });
const unconfirmed = (reason: string): DiscordLaneWakeResult => ({ kind: "unconfirmed", reason });
const wakeOverlay = join(import.meta.dir, "discord-lane-wake.yml");

function sameWakeTarget(seen: Lane, current: Lane): boolean {
  const before = sessionOf(seen);
  const now = sessionOf(current);
  const status = statusOf(current);
  return (
    sameLaneGeneration(seen, current) &&
    (status === "working" || status === "not-done") &&
    !current.hold &&
    !current.nativeCloseIntent &&
    before?.runtime === now?.runtime &&
    before?.id === now?.id &&
    before?.group === now?.group &&
    seen.thread === current.thread &&
    seen.session === current.session &&
    seen.sessionFile === current.sessionFile &&
    seen.cwd === current.cwd
  );
}

async function attestWake(deps: FlowDeps, lane: Lane, check: WakeLease): Promise<DiscordLaneWakeResult> {
  const ref = sessionOf(lane);
  const epoch = lane.lifecycleEpoch && discordWakeCompletedEpoch(lane.lifecycleEpoch);
  if (ref?.runtime !== "herdr" || !epoch || !lane.sessionFile) return held("earlier wake requires inspection");
  const state = await trustedPaneState(deps.run, deps.config.stateDir, ref, runtimesOf(deps), true);
  if (
    state?.role !== "lane" ||
    state.discordLaneInbox !== true ||
    state.sessionId !== check.session ||
    state.sessionFile !== lane.sessionFile ||
    (await realpath(state.sessionFile)) !== lane.sessionFile ||
    !isAbsolute(state.cwd) ||
    (await realpath(state.cwd)) !== check.cwd
  )
    return unconfirmed("waiting for exact live OMP pane, transcript and directory");
  if (!(await ownsWakeLease(deps, check, state.pid)))
    return unconfirmed("exact OMP lease ownership by the pane's native PID was not verified");
  const completed = await deps.registry.transition(lane, (current) =>
    sameWakeTarget(lane, current) ? { ...current, lifecycleEpoch: epoch } : null,
  );
  return completed ? { kind: "started", ref } : unconfirmed("the lane changed during startup attestation");
}

async function startExactLane(deps: FlowDeps, seen: Lane): Promise<DiscordLaneWakeResult> {
  let reserved = false;
  try {
    const lane = await deps.registry.read(seen.key);
    if (!lane || !sameWakeTarget(seen, lane)) return held("lane no longer eligible");
    if (isDiscordWakePending(lane.lifecycleEpoch)) {
      reserved = true;
      const command = wakeCommand(deps.config.agentCommand);
      if (!command || !lane.cwd || !lane.session) return held("earlier wake requires inspection");
      return await attestWake(deps, lane, { argv: command.lease, session: lane.session, cwd: lane.cwd });
    }
    if (process.platform !== "linux") return held("exact OMP lease ownership requires Linux");
    const prior = sessionOf(lane);
    const session = lane.session;
    if (prior?.runtime !== "herdr" || parseRef(prior.id)?.id !== prior.id || !session)
      return held("no exact Herdr session registered");
    const rts = runtimesOf(deps);
    const rt = rts.for(prior);
    if ((await rt.probe(prior)).status !== "gone") return held("registered pane still exists");
    const old = readPaneState(deps.config.stateDir, prior.id);
    const goal = nativeGoalStatus(old);
    if (
      old?.paneId !== prior.id ||
      old.role !== "lane" ||
      old.discordLaneInbox !== true ||
      old.pid !== 0 ||
      old.sessionId !== session ||
      old.approvalPending !== false ||
      !goal ||
      goal === "paused" ||
      goal === "blocked" ||
      typeof old.sessionFile !== "string" ||
      typeof old.cwd !== "string" ||
      !isAbsolute(old.cwd) ||
      !(Date.parse(old.updatedAt) >= Date.parse(lane.openedAt))
    )
      return held("retired pane identity or goal not eligible");
    const command = wakeCommand(deps.config.agentCommand);
    if (!command) return held("agent command is not an exact interactive OMP template");
    const cwd = await realpath(old.cwd);
    if ((lane.cwd !== undefined && (await realpath(lane.cwd)) !== cwd) || !(await stat(cwd)).isDirectory())
      return held("recorded lane directory differs");
    const transcript = await exactDiscordLaneTranscript(old.sessionFile, {
      root: deps.config.sessionsDir,
      session,
      cwd,
    });
    if (!transcript || (lane.sessionFile !== undefined && (await realpath(lane.sessionFile)) !== transcript.file))
      return held("exact saved transcript not verified");
    const { file, model } = transcript;
    const lanes = await deps.registry.open();
    if (
      lanes.some(
        (peer) =>
          peer.key !== lane.key &&
          (peer.session === session || (peer.sessionRef?.runtime === "herdr" && peer.sessionRef.id === prior.id)),
      )
    )
      return held("session already has another registered owner");
    const peers = await listSessions(rts, { lanes });
    for (const { ref } of peers) {
      if (ref.runtime === "herdr" && ref.id === prior.id) return held("registered pane still exists");
      const peer = await rts.for(ref).probe(ref, { foregroundOnly: true });
      if (peer.sessionId === session) return held("another pane owns the recorded session");
    }
    if (!canLaunch(await sampleHost(deps.run, cwd, rts), deps.config.guard).ok) return held("host launch guard holds");
    const check = { argv: command.lease, session, cwd };
    if ((await wakeLeaseState(deps, check)) !== "free") return held("OMP session lease is held or unverified");
    const env = {
      ...laneLaunchEnv(deps.env ?? process.env, deps.env?.["DORI_CONFIG"] ?? configPath(), deps.config),
      DORI_DISCORD_WAKE_SESSION: session,
      DORI_DISCORD_WAKE_GOAL: goal,
      DORI_DISCORD_WAKE_MODEL: model ?? "",
    };
    const group = prior.group ?? prior.id.slice(0, prior.id.indexOf(":"));
    // Last-tab close removes a workspace. `pane list` on this same Herdr adapter already
    // observes every surviving workspace through its root panes.
    const hasGroup = peers.some(({ ref }) => ref.runtime === "herdr" && ref.group === group);
    const start = [...command.launch, "--config", wakeOverlay, `--resume=${file}`].map(quoteForPane).join(" ");
    const epoch = randomUUID();
    // Commit before the first side effect. If the monitor dies during create, bind, or start, even a new
    // monitor must hold. Once bound, keep the new pane for inspection; a failed start receipt does not prove no start.
    const intent = await deps.registry.transition(lane, (current) =>
      sameWakeTarget(lane, current) ? { ...current, lifecycleEpoch: discordWakePendingEpoch(epoch) } : null,
    );
    if (!intent) return held("lane changed before wake");
    reserved = true;
    const ref = await rt.create({
      name: lane.key,
      cwd,
      env,
      role: "lane",
      ...(hasGroup ? { container: "tab", group } : { container: "workspace-root" }),
    });
    if (
      ref.runtime !== "herdr" ||
      !ref.group ||
      !ref.id.startsWith(`${ref.group}:`) ||
      (hasGroup
        ? ref.group !== group
        : ref.group === group || peers.some((peer) => peer.ref.runtime === "herdr" && peer.ref.group === ref.group)) ||
      parseRef(ref.id)?.id !== ref.id ||
      ref.id === prior.id ||
      peers.some((p) => p.ref.runtime === ref.runtime && p.ref.id === ref.id) ||
      readPaneState(deps.config.stateDir, ref.id) !== null
    )
      return unconfirmed("new Herdr pane identity was not verified");
    if ((await wakeLeaseState(deps, check)) !== "free")
      return unconfirmed("OMP session acquired another owner during wake");
    const shell = await rt.probe(ref);
    if (
      shell.status !== "shell" ||
      !isBareLaneShell(shell) ||
      shell.rootPid === undefined ||
      shell.rootPid <= 0 ||
      shell.pgid !== shell.rootPid ||
      shell.foreground?.[0]?.pid !== shell.rootPid ||
      !shell.cwd ||
      (await realpath(shell.cwd)) !== cwd
    )
      return unconfirmed("new Herdr pane did not have the expected idle shell");
    const bound = await deps.registry.transition(intent, (current) => {
      if (!sameWakeTarget(intent, current)) return null;
      const { tab: _oldTab, ...rest } = current;
      return { ...rest, ...sessionFields(ref), cwd, sessionFile: file, lifecycleEpoch: discordWakeBoundEpoch(epoch) };
    });
    if (!bound) return unconfirmed("lane changed before starting the new Herdr pane");
    await rt.start(ref, start);
    // Herdr's reply only acknowledges PTY input. A later tick can attest the bound pane
    // even if that reply was lost, without ever creating or starting a second pane.
    return await attestWake(deps, bound, check);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Runtime and filesystem errors can contain private launch arguments or transcript paths.
    return reserved
      ? unconfirmed("wake interrupted after reservation; inspect before any manual restart")
      : held("wake prerequisites could not be verified");
  }
}

/** Caller owns pending-inbox admission. This only requests startup, never types a message or resumes a goal. */
export async function wakeDiscordLane(deps: FlowDeps, seen: Lane): Promise<DiscordLaneWakeResult> {
  if (!LANE_KEY.test(seen.key) || seen.key === RESERVED_LANE_KEY) return held("invalid lane key");
  const lock = await withDeliveryLock(deps, seen.key, () => startExactLane(deps, seen), 0);
  return lock.ok ? lock.value : held("lane delivery lock in use");
}
