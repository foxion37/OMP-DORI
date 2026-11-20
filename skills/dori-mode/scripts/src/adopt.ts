/** `dori adopt`: a lane that is already running, registered from its session id instead of opened. */
import { parseRef } from "../../../../src/runtime/types.ts";
import { withLaunchLock } from "./delivery-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { LaunchError } from "./launch.ts";
import { type LaunchInput, validateLaunch } from "./launch-input.ts";
import { laneLabel } from "./labels.ts";
import { groupOf } from "./placement.ts";
import { type Lane, sessionFields, upgradeLane } from "./registry.ts";
import { iso } from "./run.ts";

export const adoptLane = async (
  deps: FlowDeps,
  input: LaunchInput & { readonly pane: string },
  locked = false,
): Promise<Lane> => {
  await validateLaunch(deps, input, LaunchError);
  if (!locked) {
    const held = await withLaunchLock(deps, input.key, () => adoptLane(deps, input, true));
    if (!held.ok) throw new LaunchError(`lane ${input.key} held: ${held.holder}`);
    return held.value;
  }
  const thread = input.thread?.trim() ? input.thread : "none";
  const base: Lane = {
    key: input.key,
    title: input.title,
    thread,
    label: laneLabel({ title: input.title, thread }),
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
  if (!(await deps.registry.create(lane))) throw new LaunchError(`lane ${input.key} is already registered`);
  return lane;
};
