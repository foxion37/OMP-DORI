/** dori launch, adopt, claim-done, object-done, close, pause, resume, context, relay and tell. */
import { resolve } from "node:path";
import { type Command, die, every } from "./cli-context.ts";
import { contextTick } from "./context.ts";
import { enqueueLaunch, startQueued, cancelQueued } from "./launch-queue.ts";
import { LaunchQueue } from "./launch-queue-store.ts";
import { autoTrackLinks } from "./cli-pr.ts";
import { claimDone, closeLane, objectDone } from "./done-flow.ts";
import { adoptLane } from "./adopt.ts";
import { launchLane, prepareLaunch } from "./launch.ts";
import type { LaunchInput } from "./launch-input.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { parkLane } from "./park.ts";
import { relayLane } from "./relay.ts";
import { reopenLane } from "./reopen.ts";
import { holdLines } from "./holds.ts";
import { tellLane } from "./tell.ts";
import { statusOf } from "./registry.ts";

const launch: Command = async ({ key, opt, need, ceiling, strings, values, deps }) => {
  const wallMinutes = ceiling("wall-minutes"),
    tokens = ceiling("token-limit"),
    costUsd = ceiling("cost-limit");
  const thread = opt("thread"),
    model = opt("model"),
    cwd = opt("cwd"),
    group = opt("group");
  const template = opt("template");
  if (template && opt("brief")) die("choose --brief or --template, not both");
  if (!template && strings("set").length) die("--set requires --template");
  const variables = Object.fromEntries(
    strings("set").map((setting) => {
      const at = setting.indexOf("=");
      const name = setting.slice(0, at);
      if (at < 1 || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(name)) return die("--set requires name=value");
      return [name, setting.slice(at + 1)];
    }),
  );
  const input: LaunchInput = {
    key: key ?? "",
    title: need("title"),
    brief: template ? resolve(deps.config.stateDir, "briefs", `${key}.md`) : need("brief"),
    ...(template ? { template, variables } : {}),
    done: need("done"),
    ...(thread !== undefined ? { thread } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(group !== undefined ? { group } : {}),
    budget: {
      ...(wallMinutes !== undefined ? { wallMinutes } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    },
    activityPaths: strings("activity-path"),
  };
  if (values["dry-run"]) {
    const prepared = await prepareLaunch(deps, input);
    for (const warning of prepared.warnings) console.error(warning);
    console.log(prepared.preamble);
    return;
  }
  const after = opt("after");
  if (after !== undefined) {
    const entry = await enqueueLaunch(
      deps,
      input,
      after.split(",").map((s) => s.trim()),
      Number(opt("expires-hours") ?? 24),
    );
    console.log(
      `QUEUED ${entry.input.key} after=${entry.after.join(",")} expires=${entry.expiresAt}; explicit dori queue start required`,
    );
    return;
  }
  if (opt("expires-hours") !== undefined) die("--expires-hours requires --after");
  const r = await launchLane(deps, input);
  for (const warning of r.warnings) console.error(warning);
  console.log(
    `LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"} placement=${r.lane.placement ?? "?"} workspace=${r.lane.workspace ?? "?"}${r.lane.group ? ` group=${r.lane.group}` : ""}`,
  );
  console.log(r.startup);
  process.exit(r.startup.startsWith("STARTUP_OK") || r.startup.startsWith("STARTUP_DONE") ? 0 : 3);
};

const adopt: Command = async ({ key, opt, need, deps }) => {
  const thread = opt("thread");
  const group = opt("group");
  const l = await adoptLane(deps, {
    key: key ?? "",
    title: need("title"),
    brief: need("brief"),
    done: need("done"),
    ...(thread !== undefined ? { thread } : {}),
    ...(group !== undefined ? { group } : {}),
    pane: need("pane"),
  });
  console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}${l.group ? ` group=${l.group}` : ""}`);
};

const context: Command = async ({ values, loopMinutes, deps }) => {
  const relay = values["relay"] === true;
  await every(loopMinutes(), async () => {
    for (const line of await contextTick(deps, { relay })) console.log(line);
  });
};

const relay: Command = async ({ key, lane, deps }) => {
  const result = await relayLane(deps, await lane(key ?? die("relay needs a lane key")));
  for (const line of result.lines) console.log(line);
  process.exit(result.outcome === "relayed" ? 0 : result.outcome === "skipped" ? 2 : 3);
};

const close: Command = async ({ key, opt, strings, values, lane, deps }) => {
  const target = await lane(key ?? die("close needs a lane key"));
  if (values["abandon"]) {
    const reason = strings("reason")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("; ");
    if (!reason) die("close --abandon requires --reason");
    if (opt("lesson")) die("--lesson is only for a verified completion");
    const r = await parkLane(deps, target, reason, "abandoned");
    for (const line of r.lines) console.log(line);
    process.exit(r.code);
  }
  const rule = opt("lesson");
  const r = await closeLane(
    deps,
    target,
    opt("note") ?? "closed by the lead",
    rule === undefined ? undefined : { rule, evidence: opt("evidence") ?? target.done },
  );
  for (const line of r.lines) console.log(line);
  process.exit(r.closed ? 0 : r.lines.at(-1)?.startsWith("LANE_CHANGED") ? 3 : 2);
};

/** Prints a done-flow result; `LANE_CHANGED` (another writer moved the lane on, nothing recorded) exits 3. */
const recorded = (line: string): void => {
  console.log(line);
  if (line.startsWith("LANE_CHANGED")) process.exit(3);
};

const pauseOrResume: Command = async ({ command, key, opt, lane, deps }) => {
  const act = command === "pause" ? pauseLane : resumeLane;
  const r = await act(
    deps,
    await lane(key ?? die(`${command} needs a lane key`)),
    opt("note") ?? `${command}d by the lead`,
  );
  for (const line of r.lines) console.log(line);
  process.exit(r.code);
};

const tell: Command = async ({ key, need, lane, deps }) => {
  const target = await lane(key ?? die("tell needs a lane key"));
  const r = await tellLane(deps, target, need("text"));
  console.log(r.line);
  process.exit(r.code);
};

export const laneCommands: Readonly<Record<string, Command>> = {
  launch,
  queue: async ({ key: action, positionals, values, deps }) => {
    if (action === "list") {
      const scan = new LaunchQueue(deps.config.stateDir).scan();
      console.log(JSON.stringify(scan.entries, null, 2));
      for (const problem of scan.problems) console.error(`QUEUE_UNREADABLE ${problem}`);
      process.exitCode = scan.problems.length ? 1 : 0;
      return;
    }
    const key = positionals[1] ?? die("queue needs list, start <key>, or cancel <key>");
    if (values["dry-run"] !== undefined && (action === "start" || action === "cancel"))
      die("--dry-run is supported only by dori launch, not queue start or cancel");
    if (action === "cancel") {
      console.log(await cancelQueued(deps, key));
      return;
    }
    if (action !== "start") die("queue needs list, start <key>, or cancel <key>");
    const result = await startQueued(deps, key);
    for (const line of result.lines) console.log(line);
    process.exit(result.code);
  },
  adopt,
  context,
  relay,
  lanes: async ({ values, need, deps }) => {
    const thread = values["thread"] === undefined ? undefined : need("thread");
    const lanes = (await deps.registry.list()).filter(
      (lane) => (thread === undefined || lane.thread === thread) && (!values["open"] || statusOf(lane) !== "closed"),
    );
    console.log(
      JSON.stringify(
        lanes.map((lane) => ({
          key: lane.key,
          title: lane.title,
          thread: lane.thread,
          status: statusOf(lane),
          openedAt: lane.openedAt,
          closedAt: lane.closedAt,
        })),
        null,
        2,
      ),
    );
  },
  "claim-done": async (cli) => {
    const target = await cli.lane(cli.key);
    const evidence = cli.need("evidence");
    recorded(
      await claimDone(cli.deps, target, evidence, () =>
        autoTrackLinks(cli, target, evidence, `claim-done ${target.key}`),
      ),
    );
  },
  "object-done": async ({ key, values, lane, deps }) => {
    const reasons = (values["reason"] as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
    if (!reasons.length) die("--reason is required");
    recorded(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
  },
  close,
  park: async ({ key, need, opt, lane, deps }) => {
    const r = await parkLane(
      deps,
      await lane(key ?? die("park needs a lane key")),
      need("note"),
      "parked",
      opt("resume-when"),
    );
    for (const line of r.lines) console.log(line);
    process.exit(r.code);
  },
  reopen: async ({ key, opt, deps }) => {
    const target = await deps.registry.read(key ?? die("reopen needs a lane key"));
    if (!target) return die(`no registered lane "${key}"`);
    const r = await reopenLane(deps, target, opt("note"));
    for (const line of r.lines) console.log(line);
    process.exit(r.code);
  },
  holds: async ({ opt, deps }) => {
    for (const line of holdLines(await deps.registry.list(), opt("thread"))) console.log(line);
  },
  pause: pauseOrResume,
  resume: pauseOrResume,
  tell,
};
