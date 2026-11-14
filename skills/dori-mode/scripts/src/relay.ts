import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import type { SessionRef } from "../../../../src/runtime/types.ts";
import { configPath, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { checkStartup } from "./launch.ts";
import { quoteForPane } from "./launch-footer.ts";
import { splitFrom } from "./placement.ts";
import { type Lane, sessionFields, sessionOf, statusOf } from "./registry.ts";
import { iso, runtimesOf } from "./run.ts";
import { sendVerified, statusLookup } from "./sessions.ts";
import { trustedPaneState } from "./session-id.ts";
import { laneLaunchEnv, TokenFileError } from "./slack-token.ts";

export type RelayResult = { readonly outcome: "relayed" | "skipped" | "failed"; readonly lines: string[] };

const POLL_MS = 3_000;
/** An agent in these states is there and takes the message: herdr's "done" is an agent waiting at its prompt. */
const RELAYABLE: Readonly<Record<string, true>> = { idle: true, working: true, done: true };

export const handoffPath = (stateDir: string, key: string, n: number): string =>
  join(stateDir, "handoffs", `${key}-${n}.md`);

const size = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
};

/** The handoff counts as written once it is non-empty and its size held across one poll (the lane may still be typing it). */
const waitForHandoff = async (deps: FlowDeps, path: string): Promise<boolean> => {
  const deadline = deps.clock.now() + deps.config.relayTimeoutMin * 60_000;
  let last = -1;
  for (;;) {
    const now = size(path);
    if (now > 0 && now === last) return true;
    last = now;
    if (deps.clock.now() >= deadline) return false;
    await deps.clock.sleep(POLL_MS);
  }
};

const fail = (key: string, why: string): RelayResult => ({ outcome: "failed", lines: [`RELAY_FAILED ${key} ${why}`] });
const skip = (key: string, why: string): RelayResult => ({
  outcome: "skipped",
  lines: [`RELAY_SKIPPED ${key} ${why}`],
});

/** The environment a lane is created with, so its successor runs under the same config and label. */
const successorEnv = (): Record<string, string> => {
  try {
    return laneLaunchEnv(process.env, configPath());
  } catch (e) {
    throw e instanceof TokenFileError ? new Error(`token file refused: ${e.message}`) : e;
  }
};

/**
 * Hands a lane over to a fresh session: the lane writes a handoff, a successor starts below it from the same brief plus
 * that handoff, and only after the successor's startup check passes is the old session closed. Any failure before that
 * leaves the old lane exactly as it was.
 */
export const relayLane = async (deps: FlowDeps, listed: Lane): Promise<RelayResult> => {
  const lane = (await deps.registry.read(listed.key)) ?? listed;
  const key = lane.key;
  const ref = sessionOf(lane);
  if (ref === undefined) return skip(key, "lane has no session");
  const status = statusOf(lane);
  if (status !== "working" && status !== "not-done") return skip(key, `lane is ${status}`);
  const state = await trustedPaneState(deps.run, deps.config.stateDir, ref);
  if (state?.approvalPending) return skip(key, "a tool approval prompt is open");
  const agent = await statusLookup(runtimesOf(deps), ref);
  if (agent.error) return skip(key, `status lookup failed: ${agent.error}`);
  // herdr reports "done" for an agent that finished a turn and waits at its prompt: alive, and it takes the message.
  if (agent.status === undefined || RELAYABLE[agent.status] !== true)
    return skip(key, `agent status is ${agent.status ?? "none"}`);

  const n = (lane.relays ?? 0) + 1;
  const handoff = handoffPath(deps.config.stateDir, key, n);
  mkdirSync(join(deps.config.stateDir, "handoffs"), { recursive: true });
  if (existsSync(handoff)) renameSync(handoff, `${handoff}.stale-${deps.clock.now()}`);
  const ask = `[LEAD] context is filling up. Stop starting new work, finish the step you are on, then write a handoff to ${handoff} with: goal, done and not done, evidence, files/branches/SHAs, the next 1-3 steps; no secrets. Print HANDOFF-WRITTEN when the file is saved and stay idle: a successor session takes over.`;
  if ((await sendVerified(runtimesOf(deps), deps.clock, ref, ask)) === "failed")
    return fail(key, "could not message the lane");
  if (!(await waitForHandoff(deps, handoff))) return fail(key, "handoff not written");

  const cwd = lane.cwd ?? deps.config.defaultCwd;
  const model = lane.model ?? deps.config.defaultModel;
  let fresh: SessionRef;
  try {
    fresh = await splitFrom(deps, ref, { name: key, cwd, env: successorEnv() });
  } catch (e) {
    return fail(key, e instanceof Error ? e.message : String(e));
  }
  const prompt = `${deps.config.launchKeywords}. Read the lane brief at ${lane.brief} and the handoff at ${handoff}; you are the ${key} lane taking over; verify the handoff against the real state, then continue.`;
  let startup: string;
  try {
    await runtimesOf(deps)
      .for(fresh)
      .start(fresh, fill(deps.config.agentCommand, { model, prompt }).map(quoteForPane).join(" "));
    startup = await checkStartup(deps, key, fresh);
  } catch (e) {
    startup = `STARTUP_ERROR ${key} ${fresh.id}: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!startup.startsWith("STARTUP_OK")) {
    await runtimesOf(deps)
      .for(fresh)
      .close(fresh, "session")
      .catch(() => undefined);
    return fail(key, `successor did not start (${startup.slice(0, 200)}); old session ${ref.id} kept`);
  }

  const { session: _session, sessionVia: _via, ...kept } = lane;
  await deps.registry.write({
    ...kept,
    ...sessionFields(fresh),
    ...((lane.workspace ?? fresh.group === undefined) ? {} : { workspace: fresh.group }),
    placement: "split",
    relays: n,
    previousPanes: [...(lane.previousPanes ?? []), ref.id],
    lastRelayAt: iso(deps.clock),
    contextAlerted: false,
    relayFailed: false,
    contextUnknownAlerted: false,
  });
  const closed = await runtimesOf(deps)
    .for(ref)
    .close(ref, "session")
    .then(() => true)
    .catch(() => false);
  return {
    outcome: "relayed",
    lines: [`RELAYED ${key} ${ref.id} -> ${fresh.id}${closed ? "" : ` (old session ${ref.id} could not be closed)`}`],
  };
};
