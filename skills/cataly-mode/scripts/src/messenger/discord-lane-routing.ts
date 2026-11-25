import { headlessDiscordLaneAvailable } from "../discord-lane-headless-state.ts";
import { readPaneState } from "../lane-state.ts";
import { type Lane, Registry, statusOf } from "../registry.ts";

export async function uniqueDiscordLane(
  stateDir: string,
  match: (lane: Lane) => boolean,
  allowSharedChannel = false,
): Promise<Lane | undefined> {
  const scan = await new Registry(stateDir).scan();
  if (scan.unreadable.length) return undefined;
  return matchingDiscordLane(openDiscordLanes(scan.lanes), match, allowSharedChannel);
}

const openDiscordLanes = (lanes: readonly Lane[]) => lanes.filter((lane) => statusOf(lane) !== "closed");

function matchingDiscordLane(open: readonly Lane[], match: (lane: Lane) => boolean, allowSharedChannel = false) {
  const matches = open.filter(match);
  const lane = matches[0];
  if (matches.length !== 1 || !lane?.sessionRef) return undefined;
  const { id, runtime } = lane.sessionRef;
  if (
    open.some(
      (other) =>
        other !== lane &&
        ((!allowSharedChannel && other.thread === lane.thread) ||
          (other.sessionRef?.id === id && other.sessionRef.runtime === runtime) ||
          (lane.session !== undefined && lane.session === other.session)),
    )
  )
    return undefined;
  return lane;
}

type DiscordLaneRoute =
  | { readonly kind: "ambiguous" }
  | { readonly kind: "closing" | "inactive" | "native-unavailable"; readonly key: string }
  | { readonly kind: "live"; readonly key: string; readonly session: string };

/** Keep an exact registered owner distinct from an unowned channel, even without a live pane. */
export async function discordLaneRoute(stateDir: string, channel: string): Promise<DiscordLaneRoute | undefined> {
  const scan = await new Registry(stateDir).scan();
  if (scan.unreadable.length) return { kind: "ambiguous" };
  const open = openDiscordLanes(scan.lanes);
  const match = (item: Lane) => item.thread === `discord:${channel}`;
  if (!open.some(match)) return undefined;
  const lane = matchingDiscordLane(open, match);
  if (!lane?.sessionRef) return { kind: "ambiguous" };
  const { key } = lane;
  if (lane.nativeCloseIntent) return { kind: "closing", key };
  if (lane.sessionRef.runtime === "headless") {
    if (lane.session && (await headlessDiscordLaneAvailable(stateDir, lane)))
      return { kind: "live", key, session: lane.session };
    return { kind: "native-unavailable", key };
  }
  const inactive = { kind: "inactive", key } as const;
  const pane = readPaneState(stateDir, lane.sessionRef.id);
  if (pane?.role !== "lane" || pane.discordLaneInbox !== true) return inactive;
  // Only an exact registered session can route on a clean retirement; a launch hint alone cannot.
  const active = { kind: "live", key, session: pane.sessionId } as const;
  if (lane.session === pane.sessionId && pane.pid === 0) return active;
  if (
    pane.pid <= 0 ||
    (lane.session !== pane.sessionId && (lane.session !== undefined || pane.discordLaneKey !== lane.key))
  )
    return inactive;
  try {
    process.kill(pane.pid, 0);
  } catch {
    return inactive;
  }
  return active;
}

export async function discordLaneTarget(
  stateDir: string,
  channel: string,
): Promise<{ key: string; session: string } | undefined> {
  const route = await discordLaneRoute(stateDir, channel);
  if (route?.kind === "live") return { key: route.key, session: route.session };
  return undefined;
}
