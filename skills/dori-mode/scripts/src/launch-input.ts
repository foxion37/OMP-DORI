import type { FlowDeps } from "./done-flow.ts";
import { LaunchQueue } from "./launch-queue-store.ts";
import { GROUP_NAME } from "./placement.ts";
import { LANE_KEY, RESERVED_LANE_KEY } from "./registry.ts";
import { doneSyntaxErrors } from "./signals.ts";
import type { BudgetLimits } from "./supervision-observe.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly template?: string;
  readonly variables?: Readonly<Record<string, string>>;
  /** Internal reservation identity, supplied only by explicit queue start. */
  readonly queueId?: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
  /** Work stream: a lane of the same group is split below it, a new group opens its own workspace. */
  readonly group?: string;
};

export const validateLaunch = async (
  deps: FlowDeps,
  input: LaunchInput,
  LaunchError: new (message: string) => Error,
): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (input.key === RESERVED_LANE_KEY)
    throw new LaunchError(`lane key "${RESERVED_LANE_KEY}" is reserved for the lead`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  const queued = new LaunchQueue(deps.config.stateDir).read(input.key);
  if (queued && queued.status !== "cancelled" && !(queued.status === "starting" && input.queueId === queued.id))
    throw new LaunchError(`lane ${input.key} is queued; use dori queue start`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
  if (input.group !== undefined && !GROUP_NAME.test(input.group))
    throw new LaunchError(`group must match ${GROUP_NAME}`);
  for (const [name, value] of Object.entries(input.budget ?? {})) {
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new LaunchError(`invalid ${name} ceiling`);
  }
};
