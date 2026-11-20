import { basename } from "node:path";
import type { SweepAct } from "./freshness.ts";

// A new sweep outcome must get a diagnostic probe before the preset can compile.
const freshnessEvents = {
  nudged: true,
  "nudge-failed": true,
  posted: true,
  "post-failed": true,
  "no-report": true,
  "pending-report": true,
  "stale-report": true,
  unrelayed: true,
  stalled: true,
  "journal-error": true,
  "working-while-paused": true,
  blocked: true,
  warning: true,
  "supervision-error": true,
} satisfies Record<SweepAct["kind"], true>;

export const monitorPresets = [
  {
    name: "watch",
    argv: ["dori", "watch"],
    filter: "^LANE_",
    events: [
      "LANE_WATCH_READY",
      "LANE_WATCH_WARN",
      "LANE_DONE_CLAIMED",
      "LANE_CHANGED",
      "LANE_NOT_DONE",
      "LANE_CLOSED",
      "LANE_HELD",
      "LANE_QUEUE_READY",
      "LANE_QUEUE_HELD",
      "LANE_QUEUE_WARN",
    ],
  },
  {
    name: "dead-panes",
    argv: ["dori", "dead-panes", "--loop", "3"],
    filter: "^(DEAD_PANE|UNRECOGNISED_PANE|WARN)",
    events: ["DEAD_PANE", "UNRECOGNISED_PANE", "WARN"],
  },
  {
    name: "guard",
    argv: ["dori", "guard", "--loop", "1"],
    filter: "^(HOST_GUARD|WARN)",
    events: [
      "HOST_GUARD_READY",
      "HOST_GUARD ALERT",
      "HOST_GUARD CLEAR",
      "HOST_GUARD COMPUTE_READY",
      "HOST_GUARD COMPUTE_BUSY",
      "WARN",
    ],
  },
  {
    name: "freshness",
    argv: ["dori", "freshness", "--loop", "5"],
    filter: `^(${[...Object.keys(freshnessEvents).map((event) => event.toUpperCase()), "WARN"].join("|")})`,
    events: [...Object.keys(freshnessEvents).map((event) => event.toUpperCase()), "WARN"],
  },
  {
    name: "pr-watch",
    argv: ["dori", "pr", "watch", "--loop", "3"],
    filter: "^(PR_(FEEDBACK|CI_FAIL|HEAD_MOVED|MERGED|CLOSED|REOPENED|WATCH_WARN)|WARN)",
    events: [
      "PR_FEEDBACK",
      "PR_CI_FAIL",
      "PR_HEAD_MOVED",
      "PR_MERGED",
      "PR_CLOSED",
      "PR_REOPENED",
      "PR_WATCH_WARN",
      "WARN",
    ],
  },
] as const;

/** Only direct Dori argv is recognized; arbitrary shell scripts are not guessed from their name. */
export const monitorPresetFor = (argv: readonly string[]) => {
  let at = 0;
  if (/^bun(?:\.exe)?$/.test(basename(argv[0] ?? ""))) at = 1;
  const executable = argv[at] ?? "";
  if (
    !["dori", "omp-dori"].includes(basename(executable)) &&
    !/(?:^|\/)dori-mode\/scripts\/src\/cli\.ts$/.test(executable)
  )
    return undefined;
  return monitorPresets.find((preset) =>
    preset.name === "pr-watch" ? argv[at + 1] === "pr" && argv[at + 2] === "watch" : argv[at + 1] === preset.name,
  );
};
