import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { checkStartup, quoteForPane } from "./launch.ts";
import { statusLookup, sendVerified } from "./panes.ts";
import { splitPane } from "./placement.ts";
import { type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";

export type RelayResult = { readonly outcome: "relayed" | "skipped" | "failed"; readonly lines: string[] };

const POLL_MS = 3_000;

export const handoffPath = (stateDir: string, key: string, n: number): string => join(stateDir, "handoffs", `${key}-${n}.md`);

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
const skip = (key: string, why: string): RelayResult => ({ outcome: "skipped", lines: [`RELAY_SKIPPED ${key} ${why}`] });

/**
 * Hands a lane over to a fresh pane: the lane writes a handoff, a successor starts next to it from the same brief plus
 * that handoff, and only after the successor's startup check passes is the old pane closed. Any failure before that
 * leaves the old lane exactly as it was.
 */
export const relayLane = async (deps: FlowDeps, listed: Lane): Promise<RelayResult> => {
  const lane = (await deps.registry.read(listed.key)) ?? listed;
  const key = lane.key;
  if (!lane.pane) return skip(key, "lane has no pane");
  const oldPane = lane.pane;
  const status = statusOf(lane);
  if (status !== "working" && status !== "not-done") return skip(key, `lane is ${status}`);
  const state = await trustedPaneState(deps.run, deps.config.stateDir, oldPane);
  if (state?.approvalPending) return skip(key, "a tool approval prompt is open");
  const agent = await statusLookup(deps.run, oldPane);
  // herdr reports "done" for an agent that finished a turn and waits at its prompt: alive, and it takes the message.
  if (agent.status !== "idle" && agent.status !== "working" && agent.status !== "done") return skip(key, `agent status is ${agent.status ?? agent.error ?? "unknown"}`);

  const n = (lane.relays ?? 0) + 1;
  const handoff = handoffPath(deps.config.stateDir, key, n);
  mkdirSync(join(deps.config.stateDir, "handoffs"), { recursive: true });
  if (existsSync(handoff)) renameSync(handoff, `${handoff}.stale-${deps.clock.now()}`);
  const ask = `[LEAD] context is filling up. Stop starting new work, finish the step you are on, then write a handoff to ${handoff} with: goal, done and not done, evidence, files/branches/SHAs, the next 1-3 steps; no secrets. Print HANDOFF-WRITTEN when the file is saved and stay idle: a successor pane takes over.`;
  if ((await sendVerified(deps.run, deps.clock, oldPane, ask, deps.config.stateDir)) === "failed") return fail(key, "could not message the lane");
  if (!(await waitForHandoff(deps, handoff))) return fail(key, "handoff not written");

  const cwd = lane.cwd ?? deps.config.defaultCwd;
  const model = lane.model ?? deps.config.defaultModel;
  let fresh;
  try {
    fresh = await splitPane(deps, oldPane, n % 2 === 1 ? "right" : "down", cwd);
  } catch (e) {
    return fail(key, e instanceof Error ? e.message : String(e));
  }
  const pane = fresh.pane_id;
  const prompt = `${deps.config.launchKeywords}. Read the lane brief at ${lane.brief} and the handoff at ${handoff}; you are the ${key} lane taking over; verify the handoff against the real state, then continue.`;
  const started = await deps.run(["herdr", "pane", "run", pane, fill(deps.config.agentCommand, { model, prompt }).map(quoteForPane).join(" ")]);
  const startup = started.code === 0 ? await checkStartup(deps, key, pane) : `STARTUP_ERROR ${key} ${pane}: herdr pane run failed`;
  if (!startup.startsWith("STARTUP_OK")) {
    await deps.run(["herdr", "pane", "close", pane]);
    return fail(key, `successor did not start (${startup.slice(0, 200)}); old pane ${oldPane} kept`);
  }

  const workspace = lane.workspace ?? fresh.workspace_id;
  const tab = fresh.tab_id ?? lane.tab;
  const { session: _session, sessionVia: _via, tab: _tab, ...kept } = lane;
  await deps.registry.write({
    ...kept,
    pane,
    ...(tab ? { tab } : {}),
    ...(workspace ? { workspace } : {}),
    placement: "split",
    relays: n,
    previousPanes: [...(lane.previousPanes ?? []), oldPane],
    lastRelayAt: iso(deps.clock),
    contextAlerted: false,
    relayFailed: false,
    contextUnknownAlerted: false,
  });
  const closed = (await deps.run(["herdr", "pane", "close", oldPane])).code === 0;
  return { outcome: "relayed", lines: [`RELAYED ${key} ${oldPane} -> ${pane}${closed ? "" : ` (old pane ${oldPane} could not be closed)`}`] };
};
