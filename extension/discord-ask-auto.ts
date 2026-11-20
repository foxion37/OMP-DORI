import { dirname, isAbsolute, join } from "node:path";
import { configPath } from "../skills/dori-mode/scripts/src/config.ts";
import { type DoriRole, readPaneState } from "../skills/dori-mode/scripts/src/lane-state.ts";
import { readPrivateAskFile } from "../skills/dori-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import { discordAskReceivers } from "../skills/dori-mode/scripts/src/messenger/discord-ask-receiver.ts";
import { isDiscordSnowflake } from "../skills/dori-mode/scripts/src/messenger/discord-inbound-state.ts";
import { LANE_KEY, Registry, RESERVED_LANE_KEY, statusOf } from "../skills/dori-mode/scripts/src/registry.ts";
import { parseRef } from "../src/runtime/types.ts";
import type { DiscordAskRoute } from "./discord-ask.ts";

const LANE_ENTRY = "omp-dori:discord-ask-lane";
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
    record(LANE_ENTRY, binding);
    return binding;
  }
  const value = branch.findLast((entry) => entry.type === "custom" && entry.customType === LANE_ENTRY)?.data;
  if (!value || typeof value !== "object" || !("sessionId" in value) || value.sessionId !== sessionId) return undefined;
  return "key" in value && typeof value.key === "string" && LANE_KEY.test(value.key)
    ? { key: value.key, sessionId }
    : undefined;
}

export async function laneChannel(stateDir: string, sessionId: string, binding: AskLane | undefined) {
  const pane = process.env["HC_TERMINAL_ID"]
    ? parseRef(`hc:${process.env["HC_TERMINAL_ID"]}`)
    : parseRef(process.env["HERDR_PANE_ID"] ?? "");
  if (!pane) return undefined;
  const current = readPaneState(stateDir, pane.id);
  if (current?.pid !== process.pid || current.role !== "lane" || current.sessionId !== sessionId) return undefined;
  const matching = (await new Registry(stateDir).scan()).lanes.filter(
    (lane) =>
      lane.key !== RESERVED_LANE_KEY &&
      statusOf(lane) !== "closed" &&
      lane.sessionRef?.runtime === pane.runtime &&
      lane.sessionRef.id === pane.id,
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
  role: DoriRole,
  sessionId: string,
  binding?: AskLane,
): Promise<DiscordAskRoute | undefined> {
  const home = process.env["DORI_HOME"] ?? dirname(configPath());
  // Never let a relative override resolve against a lane's project directory.
  if (!isAbsolute(home)) return undefined;
  const tokenFile = join(home, "discord-token");
  // Older lead processes may already have the bot credential without the standard token file.
  // Lanes never use inherited messenger credentials, and discovery still requires a matching live receiver.
  const fileToken = readPrivateAskFile(tokenFile, 16_384);
  const token = (fileToken ?? (role === "dori" ? process.env["DORI_DISCORD_TOKEN"] : undefined))?.trim();
  if (!token || !/^[\w.-]+$/.test(token)) return undefined;
  const target = role === "lane" ? await laneChannel(stateDir, sessionId, binding) : undefined;
  if (role === "lane" && !target) return undefined;
  const receivers = discordAskReceivers(stateDir, token);
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
