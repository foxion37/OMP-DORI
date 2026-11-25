import { dirname, isAbsolute, join } from "node:path";
import { configPath } from "../skills/cataly-mode/scripts/src/config.ts";
import { type CatalyRole, readPaneState } from "../skills/cataly-mode/scripts/src/lane-state.ts";
import { readPrivateAskFile } from "../skills/cataly-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import { discordAskReceivers } from "../skills/cataly-mode/scripts/src/messenger/discord-ask-receiver.ts";
import { isDiscordSnowflake } from "../skills/cataly-mode/scripts/src/messenger/discord-inbound-state.ts";
import { LANE_KEY, Registry, statusOf } from "../skills/cataly-mode/scripts/src/registry.ts";
import { isCatalyEntry, SESSION_WIRE } from "../skills/cataly-mode/scripts/src/session-compat.ts";
import { selfSession } from "../src/runtime/registry.ts";
import type { DiscordAskRoute } from "./discord-ask.ts";

const LANE_ENTRY = "omp-cataly:discord-ask-lane";
type AskLaneEntry = { readonly type: string; readonly customType?: string; readonly data?: unknown };
export type AskLane = { readonly key: string; readonly sessionId: string };

export function bindAskLane(
  branch: readonly AskLaneEntry[],
  sessionId: string,
  launched: string | undefined,
  record: (kind: string, data: AskLane) => void,
): AskLane | undefined {
  if (launched && LANE_KEY.test(launched)) {
    const binding = { key: launched, sessionId };
    record(SESSION_WIRE.askLane, binding);
    return binding;
  }
  const value = branch.findLast(
    (entry) => entry.type === "custom" && isCatalyEntry(entry.customType, LANE_ENTRY),
  )?.data;
  if (!value || typeof value !== "object" || !("sessionId" in value) || value.sessionId !== sessionId) return undefined;
  return "key" in value && typeof value.key === "string" && LANE_KEY.test(value.key)
    ? { key: value.key, sessionId }
    : undefined;
}

/** The Discord channel of the open lane registered to this process's own session: headless, else its Tern block. */
export async function laneChannel(
  stateDir: string,
  sessionId: string,
  binding: AskLane | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const pane = selfSession(env);
  if (!pane) return undefined;
  // A Tern block is inherited by nested runs: only the process whose pane record names this session owns it.
  if (pane.runtime !== "headless") {
    const current = readPaneState(stateDir, pane.id);
    if (current?.pid !== process.pid || current.role !== "lane" || current.sessionId !== sessionId) return undefined;
  }
  const matching = (await new Registry(stateDir).scan()).lanes.filter(
    (lane) =>
      statusOf(lane) !== "closed" && lane.sessionRef?.runtime === pane.runtime && lane.sessionRef.id === pane.id,
  );
  const lane = matching.length === 1 ? matching[0] : undefined;
  if (
    !lane ||
    (lane.session !== sessionId &&
      !(lane.session === undefined && binding?.sessionId === sessionId && binding.key === lane.key)) ||
    typeof lane.thread !== "string" ||
    !lane.thread.startsWith("discord:")
  )
    return undefined;
  const channel = lane.thread.slice("discord:".length);
  return isDiscordSnowflake(channel) ? channel : undefined;
}

export async function automaticDiscordAskRoute(
  stateDir: string,
  role: CatalyRole,
  sessionId: string,
  binding?: AskLane,
  env = process.env,
): Promise<DiscordAskRoute | undefined> {
  const home = env["CATALY_HOME"] ?? dirname(env["CATALY_CONFIG"] ?? configPath());
  // Never let a relative override resolve against a lane's project directory.
  if (!isAbsolute(home)) return undefined;
  const tokenFile = join(home, "discord-token");
  // Older lead processes may already have the bot credential without the standard token file.
  // Lanes never use inherited messenger credentials, and discovery still requires a matching live receiver.
  const fileToken = readPrivateAskFile(tokenFile, 16_384);
  const token = (fileToken ?? (role === "cataly" ? env["CATALY_DISCORD_TOKEN"] : undefined))?.trim();
  if (!token || !/^[\w.-]+$/.test(token)) return undefined;
  const target = role === "lane" ? await laneChannel(stateDir, sessionId, binding, env) : undefined;
  if (role === "lane" && !target) return undefined;
  const receivers = discordAskReceivers(stateDir, token, env["CATALY_DISCORD_API_BASE"] ?? "");
  // A registered lane names its own destination; never fall back to the lead's channel.
  // For a lead, discovered channels are not defaults and multiple explicit destinations are ambiguous.
  const routes = new Map<string, DiscordAskRoute>();
  for (const receiver of receivers) {
    for (const channel of target ? [target] : receiver.explicit) {
      if (!receiver.watched.includes(channel)) continue;
      routes.set(`${receiver.owner}:${channel}`, {
        channel,
        owner: receiver.owner,
        token,
        receiverStateDir: stateDir,
      });
    }
  }
  return routes.size === 1 ? routes.values().next().value : undefined;
}
