import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseRef, type SessionRef } from "../../../../src/runtime/types.ts";
import type { DoriConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type Lane, sessionOf } from "./registry.ts";
import { relayLane } from "./relay.ts";
import { runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";

/** Accepts a plain regex source (`claude|opus`) or the slash form (`/claude|opus/i`); always case-insensitive. */
const claudeRegex = (pattern: string): RegExp => {
  const slash = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  return new RegExp(slash ? (slash[1] ?? "") : pattern, "i");
};

/** Claude-family models fill their useful context sooner, so they hand off earlier. */
export const handoffThreshold = (config: DoriConfig, model: string): number =>
  claudeRegex(config.contextClaudePattern).test(model) ? config.contextHandoffPct : config.contextHandoffPctOther;

const leadFile = (stateDir: string): string => join(stateDir, "context-lead.json");
const readLead = (stateDir: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(leadFile(stateDir), "utf8"));
    return typeof parsed === "object" && parsed !== null && "alerted" in parsed && parsed.alerted === true;
  } catch {
    return false;
  }
};
const writeLead = (stateDir: string, alerted: boolean): void => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(leadFile(stateDir), JSON.stringify({ alerted }));
};

/** The pane state the lane's own live agent vouched for, or null when there is none (or no session). */
const stateOf = async (deps: FlowDeps, ref: SessionRef | undefined) =>
  ref === undefined ? null : trustedPaneState(deps.run, deps.config.stateDir, ref, runtimesOf(deps));

const patch = async (deps: FlowDeps, lane: Lane, change: Partial<Lane>): Promise<Lane> => {
  const next = { ...((await deps.registry.read(lane.key)) ?? lane), ...change };
  await deps.registry.write(next);
  return next;
};

/**
 * One pass over every open lane (and the lead, report only). CONTEXT_HIGH is printed once per crossing: the lane
 * record remembers it until usage drops back under the threshold. With `relay`, a crossing starts one automatic relay;
 * a failed relay is not retried until the crossing resets, a skipped one is retried next tick.
 */
export const contextTick = async (deps: FlowDeps, opts: { readonly relay: boolean }): Promise<string[]> => {
  const out: string[] = [];
  const { config } = deps;
  for (const listed of await deps.registry.open()) {
    let lane = listed;
    const state = await stateOf(deps, sessionOf(lane));
    const ctx = state?.context;
    if (!ctx) {
      const since = Date.parse(lane.lastRelayAt ?? lane.openedAt);
      if (!lane.contextUnknownAlerted && deps.clock.now() - since >= config.contextUnknownAfterMin * 60_000) {
        out.push(`CONTEXT_UNKNOWN ${lane.key} ${lane.pane ?? "-"}`);
        await patch(deps, lane, { contextUnknownAlerted: true });
      }
      continue;
    }
    const model = state?.model ?? lane.model ?? "";
    const high = ctx.percent >= handoffThreshold(config, model);
    if (!high) {
      if (lane.contextAlerted || lane.relayFailed || lane.relaySkipNote || lane.contextUnknownAlerted) {
        await patch(deps, lane, {
          contextAlerted: false,
          relayFailed: false,
          relaySkipNote: undefined,
          contextUnknownAlerted: false,
        });
      }
      continue;
    }
    if (!lane.contextAlerted) {
      out.push(`CONTEXT_HIGH ${lane.key} ${lane.pane ?? "-"} ${model || "unknown-model"} ${Math.round(ctx.percent)}%`);
      lane = await patch(deps, lane, { contextAlerted: true, contextUnknownAlerted: false });
    }
    if (!opts.relay || lane.relayFailed) continue;
    const result = await relayLane(deps, lane);
    if (result.outcome === "relayed") out.push(...result.lines);
    else if (result.outcome === "failed") {
      out.push(...result.lines);
      await patch(deps, lane, { relayFailed: true });
    } else {
      const note = result.lines[0] ?? "";
      if (note !== lane.relaySkipNote) {
        out.push(note);
        await patch(deps, lane, { relaySkipNote: note });
      }
    }
  }
  const lead = parseRef(config.leadPane);
  if (lead) {
    const state = await stateOf(deps, lead);
    const model = state?.model ?? "";
    const high = state?.context ? state.context.percent >= handoffThreshold(config, model) : false;
    if (state?.context && high && !readLead(config.stateDir)) {
      out.push(`CONTEXT_HIGH lead ${lead.id} ${model || "unknown-model"} ${Math.round(state.context.percent)}%`);
      writeLead(config.stateDir, true);
    } else if (state?.context && !high && readLead(config.stateDir)) writeLead(config.stateDir, false);
  }
  return out;
};
