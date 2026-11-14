/** `dori adopt`: a lane that is already running, registered from its session id instead of opened. */
import { parseRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type LaunchInput, validateLaunch } from "./launch.ts";
import { laneLabel } from "./labels.ts";
import { groupOf } from "./placement.ts";
import { type Lane, sessionFields, upgradeLane } from "./registry.ts";
import { iso } from "./run.ts";

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  const base: Lane = {
    key: input.key,
    title: input.title,
    thread: input.thread ?? "none",
    label: laneLabel({ title: input.title, thread: input.thread ?? "none" }),
    brief: input.brief,
    done: input.done,
    cwd: input.cwd ?? deps.config.defaultCwd,
    openedAt: iso(deps.clock),
  };
  // `hc:t7` or `herdr:w1:p3` names its runtime; any other id is a herdr pane, as before runtimes existed.
  const ref = parseRef(input.pane);
  const seated = ref ? { ...base, ...sessionFields(ref) } : upgradeLane({ ...base, pane: input.pane });
  const workspace =
    input.group === undefined || ref === undefined ? undefined : await groupOf(deps, ref).catch(() => undefined);
  // A workspace someone else opened is never dori's to close, so `workspaceCreated` stays unset here.
  const lane: Lane = {
    ...seated,
    ...(input.group === undefined ? {} : { group: input.group }),
    ...(workspace === undefined ? {} : { workspace }),
  };
  await deps.registry.write(lane);
  return lane;
};
