/** dori pr track, untrack, list and watch: follow a PR's reviews, CI, outside commits and merge after its lane. */
import { type Cli, type Command, die, every } from "./cli-context.ts";
import {
  isToken,
  parsePrRef,
  PrTracking,
  PrWatchError,
  type PrWatchState,
  prKey,
  prLinks,
  prName,
  type TrackedPr,
} from "./pr-watch.ts";
import { prWatchPass, type WatchMemory } from "./pr-watch-tick.ts";
import { realClock, run } from "./run.ts";

export const prErrors = [PrWatchError] as const;

const refArg = ({ positionals }: Cli, sub: string) => {
  const text = positionals[1] ?? die(`pr ${sub} needs owner/repo#N or a pull-request link`);
  return parsePrRef(text) ?? die(`pr ${sub}: not owner/repo#N or a https://github.com/owner/repo/pull/N link: ${text}`);
};

const track = async (cli: Cli): Promise<void> => {
  const { opt, deps, config } = cli;
  const ref = refArg(cli, "track");
  const laneKey = opt("lane");
  const lane = laneKey === undefined ? undefined : await deps.registry.read(laneKey);
  if (laneKey !== undefined && !lane) die(`no registered lane "${laneKey}"`);
  const given = opt("thread");
  // `none` means no thread, as it does for `launch --thread none`.
  const thread = given !== undefined ? (given === "none" ? undefined : given) : lane ? laneThread(lane) : undefined;
  if (thread !== undefined && !isToken(thread)) die("--thread must be one token without spaces or control characters");
  const pr = new PrTracking(config.stateDir).track(
    ref,
    { source: "dori pr track", ...(lane ? { lane: lane.key } : {}), ...(thread !== undefined ? { thread } : {}) },
    realClock.now(),
  );
  console.log(trackedLine(pr));
};

const watch = async ({ loopMinutes, strings, opt, config }: Cli): Promise<void> => {
  const self = opt("self");
  const options = {
    ignore: new Set(strings("ignore-author").map((login) => login.trim().toLowerCase())),
    selfEmails: new Set(Object.values(config.repoIdentities).map((identity) => identity.email.trim().toLowerCase())),
    ...(self ? { self } : {}),
  };
  const memory: WatchMemory = { warned: new Map() };
  const minutes = loopMinutes();
  console.log("PR_WATCH_READY");
  await every(minutes, async () => {
    // An unreadable tracking record or a cursor that cannot be saved must reach the monitor's ^PR_ filter, once.
    try {
      const pass = await prWatchPass(config.stateDir, run, options, memory, realClock.now());
      for (const line of pass.lines) console.log(line);
      pass.commit();
      memory.warned.delete("run");
    } catch (e) {
      const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
      if (memory.warned.get("run") !== reason) console.log(`PR_WATCH_WARN run ${reason}`);
      memory.warned.set("run", reason);
    }
  });
};

const pr: Command = async (cli) => {
  const tracking = new PrTracking(cli.config.stateDir);
  switch (cli.key) {
    case "track":
      return await track(cli);
    case "untrack": {
      const ref = refArg(cli, "untrack");
      const ended = tracking.untrack(ref, realClock.now());
      console.log(ended ? `PR_UNTRACKED ${prName(ended)}` : `PR_NOT_TRACKED ${prName(ref)}`);
      return;
    }
    case "list": {
      const read = tracking.read();
      for (const problem of read.problems) console.error(`PR_WATCH_WARNING ${problem}`);
      // A damaged cursor is the watcher's to hold on; the tracking list is still worth reading.
      let state: PrWatchState = {};
      try {
        state = tracking.loadState();
      } catch (e) {
        if (!(e instanceof PrWatchError)) throw e;
        console.error(`PR_WATCH_WARNING ${e.message}`);
      }
      const watched = (p: TrackedPr) => {
        // A cursor from an earlier tracking of the same PR is not this tracking's, as in the watcher.
        const entry = state[prKey(p)];
        if (!entry || entry.since !== p.since) return null;
        const { seen, commits: _commits, ...rest } = entry;
        return { ...rest, known: seen.length };
      };
      console.log(
        JSON.stringify(
          read.prs.map((p) => ({ ...p, watch: watched(p) })),
          null,
          2,
        ),
      );
      return;
    }
    case "watch":
      return await watch(cli);
    default:
      die("pr needs track, untrack, list or watch");
  }
};

export const prCommands: Readonly<Record<string, Command>> = { pr };

/** After a recorded claim or checkpoint: track its PR links when `prAutoTrack` is on; a failure never blocks it. */
export const autoTrackLinks = (
  { config }: Cli,
  lane: { readonly key: string; readonly thread: string },
  text: string,
  source: string,
): void => {
  if (!config.prAutoTrack) return;
  try {
    for (const line of autoTrack(config.stateDir, lane, text, source, realClock.now())) console.error(line);
  } catch (e) {
    console.error(`PR_TRACK_WARNING ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** A lane's thread to route PR lines to; `launch` records a lane without one as `none`. */
export const laneThread = (lane: { readonly thread: string }): string | undefined =>
  lane.thread !== "none" && isToken(lane.thread) ? lane.thread : undefined;

/** Opt-in (`prAutoTrack`): PR links in a claim's evidence or a checkpoint's receipts are tracked for the lane. */
export const autoTrack = (
  stateDir: string,
  lane: { readonly key: string; readonly thread: string },
  text: string,
  source: string,
  now: number,
): string[] => {
  const tracking = new PrTracking(stateDir);
  const thread = laneThread(lane);
  const tracked = tracking.read().prs;
  return prLinks(text).map((ref) => {
    // A claim and its checkpoints often repeat a link: the same tracking is not written again, so a closed PR the
    // watcher already reported is not read once more on every repeat.
    const current = tracked.find((pr) => prKey(pr) === prKey(ref));
    const same = current && current.lane === lane.key && current.thread === thread;
    return trackedLine(
      same
        ? current
        : tracking.track(ref, { source, lane: lane.key, ...(thread !== undefined ? { thread } : {}) }, now),
    );
  });
};

export const trackedLine = (pr: TrackedPr): string =>
  `PR_TRACKED ${prName(pr)} lane=${pr.lane ?? "-"} thread=${pr.thread ?? "-"}`;
